using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using ShowMe.Core.Playback;
using ShowMe.Core.Speech;

namespace ShowMe.VisualStudio.Speech;

internal enum Engine
{
    Kokoro,
    Windows,
    None,
}

/// <summary>
/// Chooses a speech engine per tour, turns narration into cached audio clips, and implements the
/// player's narrator (clips + prefetch). Port of src/tts/ttsService.ts.
/// Engines: Kokoro (local neural, default) → Windows voice (fallback) → none (captions only).
/// UI thread only.
/// </summary>
internal sealed class TtsService : INarrator, IDisposable
{
    private static readonly TimeSpan AudioCacheMaxAge = TimeSpan.FromDays(14);

    private readonly KokoroClient _kokoro;
    private readonly SpeechQueue _queue;
    private readonly Dictionary<string, ClipParams> _params = new();
    private readonly string _audioDir;
    private Engine _engine = Engine.None;
    private List<string> _narrations = new();
    private List<List<string>> _sentences = new();
    private Task? _download;
    private int? _downloadPct;
    private bool _warnedFallback;

    private sealed class ClipParams
    {
        public Engine Engine;
        public string Voice = "";
        public double Speed;
        public string Dtype = "fp32";
        public string Text = "";
    }

    public TtsService(string storageDir)
    {
        _audioDir = Path.Combine(storageDir, "audio");
        Directory.CreateDirectory(_audioDir);
        PruneOldFiles(_audioDir, AudioCacheMaxAge);
        _kokoro = new KokoroClient(new KokoroHostInstaller(storageDir), Path.Combine(storageDir, "models"));
        _queue = new SpeechQueue(Synthesize);
        General.Saved += _ =>
        {
            _queue.Reset();
            Changed?.Invoke();
        };
    }

    public event Action? Changed;

    /// <summary>Human-readable engine status for the walkthrough window.</summary>
    public string Label
    {
        get
        {
            var downloading = _downloadPct is { } p ? $" · Kokoro downloading {p}%" : "";
            return _engine switch
            {
                Engine.Kokoro => $"Kokoro · {General.Instance.KokoroVoice}",
                Engine.Windows => $"Windows voice{(string.IsNullOrEmpty(General.Instance.WindowsVoice) ? "" : " · " + General.Instance.WindowsVoice)}{downloading}",
                _ => $"Captions only{downloading}",
            };
        }
    }

    /// <summary>Picks the engine and pre-computes the speech chunks for a tour. May take a moment (model load).</summary>
    public async Task PrepareTourAsync(IReadOnlyList<string> narrations)
    {
        _narrations = narrations.ToList();
        _sentences = narrations.Select(n => SpeechText.SplitSentences(SpeechText.ToSpeech(n))).ToList();
        _queue.Clear();
        _engine = await ChooseEngineAsync();
        Log.Line($"[tts] engine for this tour: {_engine}");
        Changed?.Invoke();
    }

    public IReadOnlyList<Task<string>> Clips(int index)
    {
        if (_engine == Engine.None || index >= _sentences.Count) return Array.Empty<Task<string>>();
        return _sentences[index].Select(text => _queue.Request(KeyFor(text), text)).ToList();
    }

    public void Prefetch(IReadOnlyList<int> indices)
    {
        if (_engine == Engine.None) return;
        var keys = new List<string>();
        foreach (var i in indices)
        {
            if (i >= _sentences.Count) continue;
            foreach (var text in _sentences[i])
            {
                var key = KeyFor(text);
                keys.Add(key);
                _queue.Request(key, text);
            }
        }
        _queue.Prioritize(keys);
    }

    public int SilentDurationMs(int index) => SpeechText.ReadingTimeMs(index < _narrations.Count ? _narrations[index] : "");

    /// <summary>Synthesizes a one-off sentence with the current settings (for "Test Voice").</summary>
    public async Task<string[]> SpeakOnceAsync(string text)
    {
        await PrepareTourAsync(new[] { text });
        return await Task.WhenAll(Clips(0));
    }

    public void Dispose()
    {
        _queue.Clear();
        _kokoro.Dispose();
    }

    private static string Dtype => General.Instance.KokoroModel == KokoroModelSize.q8 ? "q8" : "fp32";

    private async Task<Engine> ChooseEngineAsync()
    {
        var wanted = General.Instance.Engine;
        if (wanted == TtsEngine.None) return Engine.None;
        if (wanted == TtsEngine.Windows) return Engine.Windows;

        var dtype = Dtype;
        if (_kokoro.IsReady || _kokoro.IsModelCached(dtype))
        {
            try
            {
                await _kokoro.EnsureReadyAsync(dtype);
                return Engine.Kokoro;
            }
            catch (Exception ex)
            {
                ReportKokoroFailure(ex);
                return Engine.Windows;
            }
        }

        // First run: download in the background and narrate with the Windows voice meanwhile.
        StartDownload(dtype);
        if (!_warnedFallback)
        {
            _warnedFallback = true;
            await VS.StatusBar.ShowMessageAsync("ShowMe: using the Windows voice while the Kokoro voice downloads (one time only).");
        }
        return Engine.Windows;
    }

    private void StartDownload(string dtype)
    {
        if (_download != null) return;
        _downloadPct = 0;
        int reported = -1;
        void OnProgress(long loaded, long total)
        {
            if (total <= 0) return;
            int pct = (int)(loaded * 100 / total);
            if (pct == reported) return;
            reported = pct;
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                _downloadPct = pct;
                await VS.StatusBar.ShowProgressAsync($"ShowMe: downloading the Kokoro voice ({pct}%)", Math.Max(1, pct), 100);
                Changed?.Invoke();
            });
        }
        _kokoro.Progress += OnProgress;
        _download = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
        {
            try
            {
                await _kokoro.EnsureReadyAsync(dtype);
                await VS.StatusBar.ShowMessageAsync("ShowMe: the Kokoro voice is ready and will be used from the next tour on.");
            }
            catch (Exception ex)
            {
                ReportKokoroFailure(ex);
            }
            finally
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                _kokoro.Progress -= OnProgress;
                await VS.StatusBar.ShowProgressAsync("", 100, 100);
                _download = null;
                _downloadPct = null;
                Changed?.Invoke();
            }
        }).Task;
    }

    private static void ReportKokoroFailure(Exception ex)
    {
        Log.Line($"[tts] Kokoro unavailable: {ex.Message}");
        _ = VS.StatusBar.ShowMessageAsync("ShowMe: the Kokoro voice could not start, using the Windows voice instead. See Output › ShowMe.");
    }

    private string KeyFor(string text)
    {
        var options = General.Instance;
        var p = new ClipParams
        {
            Engine = _engine,
            Voice = _engine == Engine.Kokoro ? options.KokoroVoice.ToString() : options.WindowsVoice,
            Speed = options.ClampedSpeed,
            Dtype = Dtype,
            Text = text,
        };
        using var sha = SHA1.Create();
        var raw = $"{p.Engine}\u0001{p.Voice}\u0001{p.Speed}\u0001{(p.Engine == Engine.Kokoro ? p.Dtype : "")}\u0001{text}";
        var key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(raw))).Replace("-", "").ToLowerInvariant();
        _params[key] = p;
        return key;
    }

    private async Task<string> Synthesize(string key, string _)
    {
        if (!_params.TryGetValue(key, out var p)) throw new InvalidOperationException($"unknown clip {key}");

        if (p.Engine == Engine.Kokoro)
        {
            var file = Path.Combine(_audioDir, $"{key}.wav");
            if (File.Exists(file)) return file;
            try
            {
                await _kokoro.SynthesizeAsync(p.Text, p.Voice, p.Speed, file, p.Dtype);
                return file;
            }
            catch (Exception ex)
            {
                Log.Line($"[tts] Kokoro failed for one clip, falling back to the Windows voice: {ex.Message}");
                var fallback = Path.Combine(_audioDir, $"{key}.fallback.wav");
                await WindowsVoice.SpeakToFileAsync(p.Text, fallback, General.Instance.WindowsVoice, p.Speed);
                return fallback;
            }
        }

        var clip = Path.Combine(_audioDir, $"{key}.win.wav");
        if (File.Exists(clip)) return clip;
        await WindowsVoice.SpeakToFileAsync(p.Text, clip, p.Voice, p.Speed);
        return clip;
    }

    private static void PruneOldFiles(string dir, TimeSpan maxAge) =>
        Task.Run(() =>
        {
            var cutoff = DateTime.UtcNow - maxAge;
            foreach (var file in Directory.EnumerateFiles(dir))
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(file) < cutoff) File.Delete(file);
                }
                catch (Exception)
                {
                    // In use or gone; try again next time.
                }
            }
        });
}
