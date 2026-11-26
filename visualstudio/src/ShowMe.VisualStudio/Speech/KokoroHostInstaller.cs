using System;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;

namespace ShowMe.VisualStudio.Speech;

/// <summary>
/// Gets the Kokoro helper (ShowMe.KokoroHost.exe) onto the machine. It is about 110 MB, mostly
/// the pronunciation dictionaries, so instead of making every VSIX download that large it is
/// fetched once, the first time the Kokoro voice is used, from the GitHub release named in
/// kokoro-host.json, and checked against the SHA-256 pinned there.
/// Set SHOWME_KOKORO_HOST to a locally built ShowMe.KokoroHost.exe to skip the download.
/// </summary>
internal sealed class KokoroHostInstaller
{
    private readonly string _root;

    public KokoroHostInstaller(string storageDir) => _root = Path.Combine(storageDir, "kokoro-host");

    public static string RuntimeId => RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "win-arm64" : "win-x64";

    /// <summary>Path of the helper exe if it is installed (or overridden), else null.</summary>
    public string? InstalledExe()
    {
        var overridePath = Environment.GetEnvironmentVariable("SHOWME_KOKORO_HOST");
        if (!string.IsNullOrEmpty(overridePath)) return File.Exists(overridePath) ? overridePath : null;
        var exe = ExePath(Manifest.Load().Version);
        return File.Exists(exe) ? exe : null;
    }

    /// <summary>Downloads, verifies and unpacks the helper. Reports (loaded, total) bytes.</summary>
    public async Task<string> InstallAsync(Action<long, long> progress)
    {
        var existing = InstalledExe();
        if (existing != null) return existing;

        var manifest = Manifest.Load();
        var asset = manifest.Asset(RuntimeId);
        if (asset == null || string.IsNullOrEmpty(asset.Sha256))
            throw new InvalidOperationException($"The Kokoro helper for {RuntimeId} hasn't been published for this ShowMe build yet.");

        var versionDir = Path.Combine(_root, manifest.Version);
        Directory.CreateDirectory(versionDir);
        var zip = Path.Combine(versionDir, $"{RuntimeId}.{Environment.TickCount}.zip.part");
        try
        {
            await DownloadAsync(asset.Url, zip, progress);
            var hash = Sha256(zip);
            if (!string.Equals(hash, asset.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"The Kokoro helper download failed its integrity check (SHA-256 {hash}).");

            var staging = Path.Combine(versionDir, RuntimeId + ".staging");
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
            ZipFile.ExtractToDirectory(zip, staging);
            var target = Path.Combine(versionDir, RuntimeId);
            if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
            Directory.Move(staging, target);
        }
        finally
        {
            if (File.Exists(zip)) File.Delete(zip);
        }

        var exe = ExePath(manifest.Version);
        if (!File.Exists(exe)) throw new FileNotFoundException("The Kokoro helper archive has no ShowMe.KokoroHost.exe.", exe);
        return exe;
    }

    private string ExePath(string version) => Path.Combine(_root, version, RuntimeId, "ShowMe.KokoroHost.exe");

    private static async Task DownloadAsync(string url, string dest, Action<long, long> progress)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("ShowMe-VisualStudio/" + Vsix.Version);
        using var res = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        res.EnsureSuccessStatusCode();
        long total = res.Content.Headers.ContentLength ?? 0;
        using var source = await res.Content.ReadAsStreamAsync();
        using var target = File.Create(dest);
        var buffer = new byte[1 << 16];
        long loaded = 0;
        int read;
        var lastReport = Environment.TickCount;
        while ((read = await source.ReadAsync(buffer, 0, buffer.Length)) > 0)
        {
            await target.WriteAsync(buffer, 0, read);
            loaded += read;
            if (total > 0 && (Environment.TickCount - lastReport > 250 || loaded == total))
            {
                lastReport = Environment.TickCount;
                progress(loaded, total);
            }
        }
    }

    private static string Sha256(string file)
    {
        using var sha = SHA256.Create();
        using var stream = File.OpenRead(file);
        return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private sealed class Manifest
    {
        public string Version { get; private set; } = "0";
        private JsonElement _assets;

        public static Manifest Load()
        {
            using var stream = typeof(KokoroHostInstaller).Assembly.GetManifestResourceStream("ShowMe.kokoro-host.json")
                               ?? throw new InvalidOperationException("kokoro-host.json is missing from the extension.");
            using var doc = JsonDocument.Parse(stream);
            return new Manifest
            {
                Version = doc.RootElement.GetProperty("version").GetString() ?? "0",
                _assets = doc.RootElement.GetProperty("assets").Clone(),
            };
        }

        public AssetInfo? Asset(string rid) =>
            _assets.TryGetProperty(rid, out var a)
                ? new AssetInfo(a.GetProperty("url").GetString() ?? "", a.GetProperty("sha256").GetString() ?? "")
                : null;
    }

    private sealed class AssetInfo
    {
        public AssetInfo(string url, string sha256)
        {
            Url = url;
            Sha256 = sha256;
        }

        public string Url { get; }
        public string Sha256 { get; }
    }
}
