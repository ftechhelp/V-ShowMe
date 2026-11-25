// ShowMe Kokoro host: runs Kokoro-82M (ONNX, CPU) for the Visual Studio extension.
//
// Protocol: one JSON object per line. The messages are the same as dist/kokoroWorker.js in
// VS Code (src/tts/kokoroWorker.ts), so both extensions drive Kokoro the same way.
//
//   stdin   {"type":"init","cacheDir":"…","dtype":"fp32"|"q8"}
//           {"type":"synth","id":1,"text":"…","voice":"af_heart","speed":1,"outFile":"…\\x.wav"}
//   stdout  {"type":"progress","file":"kokoro.onnx","loaded":1,"total":2}
//           {"type":"ready","loadMs":1234} | {"type":"initFailed","message":"…"}
//           {"type":"done","id":1,"ms":321} | {"type":"failed","id":1,"message":"…"}
//
// stdout carries only protocol lines; anything else (including library logging) goes to stderr.

using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using KokoroSharp;
using KokoroSharp.Core;
using KokoroSharp.Processing;
using Microsoft.ML.OnnxRuntime;

var protocol = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
Console.SetOut(Console.Error);
var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
var host = new KokoroHost(msg =>
{
    lock (protocol) protocol.WriteLine(msg.ToJsonString());
});

string? line;
while ((line = await input.ReadLineAsync()) != null)
{
    if (line.Trim().Length == 0) continue;
    try
    {
        await host.Handle(JsonNode.Parse(line)!.AsObject());
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[kokoro-host] bad request: {ex.Message}");
    }
}
host.Dispose();

internal sealed class KokoroHost : IDisposable
{
    // Where KokoroSharp's own LoadModel() downloads from. Pinned, so a model update can't change voices underneath us.
    private const string ModelBaseUrl = "https://github.com/Lyrcaxis/KokoroSharpBinaries/releases/download/v2.0.0/";

    private readonly Action<JsonObject> _send;
    private KokoroWavSynthesizer? _synth;

    public KokoroHost(Action<JsonObject> send) => _send = send;

    public async Task Handle(JsonObject req)
    {
        switch ((string?)req["type"])
        {
            case "init":
                await Init((string)req["cacheDir"]!, (string?)req["dtype"] ?? "fp32");
                break;
            case "synth":
                await Synth(req);
                break;
            default:
                Console.Error.WriteLine($"[kokoro-host] unknown request {req.ToJsonString()}");
                break;
        }
    }

    private async Task Init(string cacheDir, string dtype)
    {
        var started = Stopwatch.StartNew();
        try
        {
            // ShowMe's "q8" setting means "the small model"; KokoroSharp's small model is fp16.
            var file = dtype == "q8" ? "kokoro-fp16.onnx" : "kokoro.onnx";
            var modelPath = Path.Combine(cacheDir, "kokorosharp-v2.0.0", file);
            if (!File.Exists(modelPath)) await Download(ModelBaseUrl + file, modelPath, file);

            var voices = Path.Combine(AppContext.BaseDirectory, "voices");
            if (Directory.Exists(voices)) KokoroVoiceManager.LoadVoicesFromPath(voices);
            // Errors only: onnxruntime otherwise logs dozens of harmless constant-folding warnings.
            _synth = KokoroWavSynthesizer.LoadModel(modelPath, new SessionOptions { LogSeverityLevel = OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR });
            _send(new JsonObject { ["type"] = "ready", ["loadMs"] = started.ElapsedMilliseconds });
        }
        catch (Exception ex)
        {
            _send(new JsonObject { ["type"] = "initFailed", ["message"] = ex.ToString() });
        }
    }

    private async Task Download(string url, string dest, string name)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        var part = $"{dest}.{Environment.ProcessId}.part";
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("ShowMe-KokoroHost/0.1");
        using var res = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        res.EnsureSuccessStatusCode();
        long total = res.Content.Headers.ContentLength ?? 0;
        await using (var source = await res.Content.ReadAsStreamAsync())
        await using (var target = File.Create(part))
        {
            var buffer = new byte[1 << 16];
            long loaded = 0;
            var lastReport = Stopwatch.StartNew();
            int read;
            while ((read = await source.ReadAsync(buffer)) > 0)
            {
                await target.WriteAsync(buffer.AsMemory(0, read));
                loaded += read;
                if (total > 0 && (lastReport.ElapsedMilliseconds > 250 || loaded == total))
                {
                    lastReport.Restart();
                    _send(new JsonObject { ["type"] = "progress", ["file"] = name, ["loaded"] = loaded, ["total"] = total });
                }
            }
        }
        if (total > 0 && new FileInfo(part).Length != total)
        {
            File.Delete(part);
            throw new IOException($"Download of {name} was incomplete.");
        }
        File.Move(part, dest, overwrite: true);
    }

    private async Task Synth(JsonObject req)
    {
        int id = (int)req["id"]!;
        var started = Stopwatch.StartNew();
        try
        {
            if (_synth == null) throw new InvalidOperationException("Kokoro is not initialized");
            var voice = KokoroVoiceManager.GetVoice((string?)req["voice"] ?? "af_heart");
            var config = new KokoroTTSPipelineConfig { Speed = (float)((double?)req["speed"] ?? 1.0) };
            var pcm = await _synth.SynthesizeAsync((string)req["text"]!, voice, config);
            var outFile = (string)req["outFile"]!;
            var tmp = $"{outFile}.{Environment.ProcessId}.tmp.wav";
            KokoroWavSynthesizer.SaveAudioToFile(pcm, tmp); // adds the WAV header to the raw PCM
            File.Move(tmp, outFile, overwrite: true);
            _send(new JsonObject { ["type"] = "done", ["id"] = id, ["ms"] = started.ElapsedMilliseconds });
        }
        catch (Exception ex)
        {
            _send(new JsonObject { ["type"] = "failed", ["id"] = id, ["message"] = ex.Message });
        }
    }

    public void Dispose() => _synth?.Dispose();
}
