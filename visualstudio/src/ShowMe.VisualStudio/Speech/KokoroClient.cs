using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace ShowMe.VisualStudio.Speech;

/// <summary>
/// Extension side of the Kokoro voice: starts ShowMe.KokoroHost.exe, tracks download progress,
/// and stops the helper after ten idle minutes to free memory. Port of src/tts/kokoro.ts; the
/// helper speaks the same messages as the VS Code worker. UI thread only.
/// </summary>
internal sealed class KokoroClient : IDisposable
{
    private static readonly TimeSpan IdleShutdown = TimeSpan.FromMinutes(10);

    private readonly KokoroHostInstaller _installer;
    private readonly string _modelsDir;
    private readonly Dictionary<int, TaskCompletionSource<bool>> _pending = new();
    private readonly Dictionary<string, (long Loaded, long Total)> _fileProgress = new();
    private Process? _proc;
    private Task? _loading;
    private TaskCompletionSource<bool>? _loadWaiter;
    private string? _loadedDtype;
    private int _nextId = 1;
    private Timer? _idleTimer;

    public KokoroClient(KokoroHostInstaller installer, string modelsDir)
    {
        _installer = installer;
        _modelsDir = modelsDir;
    }

    /// <summary>(loaded, total) bytes across the helper and model downloads.</summary>
    public event Action<long, long>? Progress;

    public bool IsReady => _proc != null && _loadedDtype != null && _loading == null;

    public bool IsModelCached(string dtype) =>
        _installer.InstalledExe() != null
        && File.Exists(Path.Combine(_modelsDir, "kokorosharp-v2.0.0", dtype == "q8" ? "kokoro-fp16.onnx" : "kokoro.onnx"));

    public Task EnsureReadyAsync(string dtype)
    {
        if (_loadedDtype != null && _loadedDtype != dtype) Dispose();
        if (IsReady) return Task.CompletedTask;
        if (_loading != null) return _loading;
        _loading = LoadAsync(dtype);
        return _loading;
    }

    private async Task LoadAsync(string dtype)
    {
        try
        {
            _fileProgress.Clear();
            var exe = await _installer.InstallAsync((loaded, total) => ReportProgress("helper", loaded, total));
            Log.Line($"[kokoro] starting {exe} ({dtype})");

            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _loadWaiter = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            proc.Start();
            _proc = proc;
            proc.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrWhiteSpace(e.Data)) Log.Line($"[kokoro] {e.Data}");
            };
            proc.BeginErrorReadLine();
            proc.Exited += (_, _) => OnExited(proc);
            _ = ReadMessagesAsync(proc);

            Send(proc, new JsonObject { ["type"] = "init", ["cacheDir"] = _modelsDir, ["dtype"] = dtype });
            await _loadWaiter.Task;
            _loadedDtype = dtype;
            ArmIdle();
        }
        catch
        {
            KillProcess();
            throw;
        }
        finally
        {
            _loading = null;
        }
    }

    public async Task SynthesizeAsync(string text, string voice, double speed, string outFile, string dtype)
    {
        await EnsureReadyAsync(dtype);
        var proc = _proc ?? throw new InvalidOperationException("Kokoro helper is not running");
        _idleTimer?.Dispose();
        int id = _nextId++;
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_pending) _pending[id] = tcs;
        try
        {
            Send(proc, new JsonObject { ["type"] = "synth", ["id"] = id, ["text"] = text, ["voice"] = voice, ["speed"] = speed, ["outFile"] = outFile });
            await tcs.Task;
        }
        finally
        {
            ArmIdle();
        }
    }

    public void Dispose()
    {
        _idleTimer?.Dispose();
        _loadWaiter?.TrySetException(new OperationCanceledException("Kokoro helper stopped"));
        RejectAll(new OperationCanceledException("Kokoro helper stopped"));
        KillProcess();
        _loadedDtype = null;
    }

    private void KillProcess()
    {
        var proc = _proc;
        _proc = null;
        if (proc == null) return;
        try
        {
            if (!proc.HasExited) proc.Kill();
        }
        catch (Exception)
        {
            // Already gone.
        }
        proc.Dispose();
    }

    private async Task ReadMessagesAsync(Process proc)
    {
        try
        {
            string? line;
            while ((line = await proc.StandardOutput.ReadLineAsync()) != null)
            {
                JsonNode? msg;
                try
                {
                    msg = JsonNode.Parse(line);
                }
                catch (JsonException)
                {
                    Log.Line($"[kokoro] {line}");
                    continue;
                }
                if (msg != null) OnMessage(msg.AsObject());
            }
        }
        catch (Exception ex)
        {
            Log.Line($"[kokoro] reading the helper failed: {ex.Message}");
        }
    }

    /// <summary>Runs on a background thread; only completes tasks and raises events.</summary>
    private void OnMessage(JsonObject msg)
    {
        switch ((string?)msg["type"])
        {
            case "progress":
                ReportProgress((string?)msg["file"] ?? "model", (long?)msg["loaded"] ?? 0, (long?)msg["total"] ?? 0);
                break;
            case "ready":
                Log.Line($"[kokoro] model ready in {(long?)msg["loadMs"]} ms");
                _loadWaiter?.TrySetResult(true);
                break;
            case "initFailed":
                Log.Line($"[kokoro] failed: {(string?)msg["message"]}");
                _loadWaiter?.TrySetException(new InvalidOperationException(FirstLine((string?)msg["message"])));
                break;
            case "done":
                Complete((int?)msg["id"] ?? -1, null);
                break;
            case "failed":
                Complete((int?)msg["id"] ?? -1, new InvalidOperationException((string?)msg["message"] ?? "synthesis failed"));
                break;
        }
    }

    private void Complete(int id, Exception? error)
    {
        TaskCompletionSource<bool>? tcs;
        lock (_pending)
        {
            if (!_pending.TryGetValue(id, out tcs)) return;
            _pending.Remove(id);
        }
        if (error == null) tcs.TrySetResult(true);
        else tcs.TrySetException(error);
    }

    private void OnExited(Process proc)
    {
        int code = -1;
        try
        {
            code = proc.ExitCode;
        }
        catch (Exception)
        {
            // Disposed.
        }
        var err = new InvalidOperationException($"Kokoro helper exited (code {code})");
        _loadWaiter?.TrySetException(err);
        RejectAll(err);
    }

    private void RejectAll(Exception err)
    {
        List<TaskCompletionSource<bool>> all;
        lock (_pending)
        {
            all = new List<TaskCompletionSource<bool>>(_pending.Values);
            _pending.Clear();
        }
        foreach (var t in all) t.TrySetException(err);
    }

    private void ReportProgress(string file, long loaded, long total)
    {
        long sumLoaded = 0, sumTotal = 0;
        lock (_fileProgress)
        {
            _fileProgress[file] = (loaded, total);
            foreach (var p in _fileProgress.Values)
            {
                sumLoaded += p.Loaded;
                sumTotal += p.Total;
            }
        }
        Progress?.Invoke(sumLoaded, sumTotal);
    }

    private void ArmIdle()
    {
        _idleTimer?.Dispose();
        lock (_pending)
        {
            if (_pending.Count > 0) return;
        }
        _idleTimer = new Timer(_ =>
        {
            Log.Line("[kokoro] idle, stopping helper");
            _ = Microsoft.VisualStudio.Shell.ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await Microsoft.VisualStudio.Shell.ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                Dispose();
            });
        }, null, IdleShutdown, Timeout.InfiniteTimeSpan);
    }

    private static void Send(Process proc, JsonObject msg)
    {
        proc.StandardInput.WriteLine(msg.ToJsonString());
        proc.StandardInput.Flush();
    }

    private static string FirstLine(string? s) => (s ?? "unknown error").Split('\n')[0].Trim();
}
