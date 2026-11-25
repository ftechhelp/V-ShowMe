using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using ShowMe.Core.Status;

namespace ShowMe.VisualStudio.Workspace;

/// <summary>
/// Watches <c>.showme/tours/*.json</c> under each workspace root and reports new or rewritten
/// tours (debounced per file, like the VS Code watcher). A root's tours folder may not exist
/// yet: the agent creates it when it writes its first tour, so missing folders are re-checked
/// every two seconds. Events arrive on background threads.
/// </summary>
internal sealed class TourWatcher : IDisposable
{
    private readonly Action<string> _onTour;
    private readonly Dictionary<string, FileSystemWatcher?> _roots = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, Timer> _debounce = new(StringComparer.OrdinalIgnoreCase);
    private readonly Timer _poll;
    private readonly object _gate = new();

    public TourWatcher(Action<string> onTour)
    {
        _onTour = onTour;
        _poll = new Timer(_ => AttachMissing(), null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));
    }

    /// <summary>Replaces the watched roots.</summary>
    public void SetRoots(IEnumerable<string> roots)
    {
        lock (_gate)
        {
            var wanted = new HashSet<string>(roots, StringComparer.OrdinalIgnoreCase);
            foreach (var old in _roots.Keys.Where(k => !wanted.Contains(k)).ToList())
            {
                _roots[old]?.Dispose();
                _roots.Remove(old);
            }
            foreach (var root in wanted)
            {
                if (!_roots.ContainsKey(root)) _roots[root] = null;
            }
        }
        AttachMissing();
    }

    public IReadOnlyList<string> Roots
    {
        get
        {
            lock (_gate) return _roots.Keys.ToList();
        }
    }

    private void AttachMissing()
    {
        lock (_gate)
        {
            foreach (var root in _roots.Keys.ToList())
            {
                if (_roots[root] != null) continue;
                var dir = TourPaths.ToursDir(root);
                if (!Directory.Exists(dir)) continue;
                try
                {
                    var w = new FileSystemWatcher(dir, "*.json")
                    {
                        NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                        IncludeSubdirectories = false,
                    };
                    w.Created += (_, e) => Fire(e.FullPath);
                    w.Changed += (_, e) => Fire(e.FullPath);
                    w.Renamed += (_, e) => Fire(e.FullPath);
                    w.Error += (_, e) =>
                    {
                        Log.Line($"[watch] watcher error in {dir}: {e.GetException().Message}");
                        Reattach(root);
                    };
                    w.EnableRaisingEvents = true;
                    _roots[root] = w;
                    Log.Line($"[watch] watching {dir}");
                }
                catch (Exception ex)
                {
                    Log.Line($"[watch] cannot watch {dir}: {ex.Message}");
                }
            }
        }
    }

    private void Reattach(string root)
    {
        lock (_gate)
        {
            if (_roots.TryGetValue(root, out var w))
            {
                w?.Dispose();
                _roots[root] = null;
            }
        }
    }

    private void Fire(string path)
    {
        if (!path.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) return;
        lock (_gate)
        {
            if (_debounce.TryGetValue(path, out var existing)) existing.Dispose();
            _debounce[path] = new Timer(_ =>
            {
                lock (_gate)
                {
                    if (_debounce.TryGetValue(path, out var t)) t.Dispose();
                    _debounce.Remove(path);
                }
                _onTour(path);
            }, null, 350, Timeout.Infinite);
        }
    }

    /// <summary>All tours under the roots, newest first.</summary>
    public IReadOnlyList<(string Path, string Title, DateTime Modified)> ListTours()
    {
        var list = new List<(string, string, DateTime)>();
        foreach (var root in Roots)
        {
            var dir = TourPaths.ToursDir(root);
            if (!Directory.Exists(dir)) continue;
            foreach (var file in Directory.EnumerateFiles(dir, "*.json"))
            {
                try
                {
                    var title = Path.GetFileNameWithoutExtension(file);
                    try
                    {
                        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(file));
                        if (doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object
                            && doc.RootElement.TryGetProperty("title", out var t)
                            && t.ValueKind == System.Text.Json.JsonValueKind.String)
                        {
                            title = t.GetString() ?? title;
                        }
                    }
                    catch (Exception)
                    {
                        // Keep the file name.
                    }
                    list.Add((file, title, File.GetLastWriteTimeUtc(file)));
                }
                catch (Exception)
                {
                    // Unreadable; skip.
                }
            }
        }
        return list.OrderByDescending(t => t.Item3).ToList();
    }

    public void Dispose()
    {
        _poll.Dispose();
        lock (_gate)
        {
            foreach (var w in _roots.Values) w?.Dispose();
            _roots.Clear();
            foreach (var t in _debounce.Values) t.Dispose();
            _debounce.Clear();
        }
    }
}
