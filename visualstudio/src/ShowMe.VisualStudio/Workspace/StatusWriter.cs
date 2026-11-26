using System;
using System.IO;
using System.Text;
using System.Threading;
using ShowMe.Core.Status;

namespace ShowMe.VisualStudio.Workspace;

/// <summary>Debounced writer for <c>.showme/status.json</c>, which agents read. Thread-safe.</summary>
internal sealed class StatusWriter : IDisposable
{
    public const string About = "Written by the ShowMe Visual Studio extension. Shows what the user is looking at. Do not edit.";

    private readonly object _gate = new();
    private readonly Timer _timer;
    private (string Dir, StatusSnapshot Data)? _pending;

    public StatusWriter() => _timer = new Timer(_ => Flush(), null, Timeout.Infinite, Timeout.Infinite);

    public void Write(string showmeDir, StatusSnapshot data)
    {
        lock (_gate)
        {
            bool scheduled = _pending != null;
            _pending = (showmeDir, data);
            if (!scheduled) _timer.Change(120, Timeout.Infinite);
        }
    }

    private void Flush()
    {
        (string Dir, StatusSnapshot Data)? p;
        lock (_gate)
        {
            p = _pending;
            _pending = null;
        }
        if (p is not { } pending) return;
        try
        {
            EnsureShowmeDir(pending.Dir);
            var file = Path.Combine(pending.Dir, "status.json");
            var tmp = file + ".tmp";
            File.WriteAllText(tmp, StatusJson.Serialize(pending.Data, About), new UTF8Encoding(false));
            // Replace in one step so an agent reading at the same moment never finds the file missing.
            if (File.Exists(file)) File.Replace(tmp, file, null);
            else File.Move(tmp, file);
        }
        catch (Exception ex)
        {
            Log.Line($"[status] could not write status.json: {ex.Message}");
        }
    }

    /// <summary>Creates <c>.showme/</c> with a self-ignoring .gitignore.</summary>
    public static void EnsureShowmeDir(string dir)
    {
        Directory.CreateDirectory(dir);
        var ignore = Path.Combine(dir, ".gitignore");
        if (!File.Exists(ignore)) File.WriteAllText(ignore, TourPaths.GitIgnoreContent, new UTF8Encoding(false));
    }

    public void Dispose() => _timer.Dispose();
}
