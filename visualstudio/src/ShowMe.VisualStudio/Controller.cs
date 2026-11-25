using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using ShowMe.Core.Playback;
using ShowMe.Core.Status;
using ShowMe.Core.Tours;
using ShowMe.VisualStudio.Editor;
using ShowMe.VisualStudio.Speech;
using ShowMe.VisualStudio.Workspace;

namespace ShowMe.VisualStudio;

/// <summary>What the walkthrough window and status bar show.</summary>
internal sealed class ViewSnapshot
{
    /// <summary>idle | loading | playing | paused | waiting | finished</summary>
    public string State { get; set; } = "idle";

    public string? Title { get; set; }
    public string? TourFile { get; set; }
    public int Index { get; set; }
    public int Total { get; set; }
    public List<StepView> Steps { get; set; } = new();
    public List<TourIssue> Issues { get; set; } = new();
    public string Voice { get; set; } = "";
}

internal sealed class StepView
{
    public string Title { get; set; } = "";
    public string? Location { get; set; }
    public string Narration { get; set; } = "";
    public string? Issue { get; set; }
}

/// <summary>
/// Glue between a loaded tour, the player, the editor presenter, the speech service and the UI.
/// Produces one snapshot that feeds the walkthrough window, the status bar and
/// <c>.showme/status.json</c>. Port of src/controller.ts. UI thread only.
/// </summary>
internal sealed class Controller : IPlayerHost, IDisposable
{
    private sealed class StepInfo
    {
        public string? Issue;
        public int[]? ShownLines;
    }

    private readonly Presenter _presenter;
    private readonly TtsService _tts;
    private readonly AudioPlayer _audio;
    private readonly StatusWriter _status;
    private Tour? _tour;
    private string? _tourPath;
    private string? _root;
    private List<TourIssue> _parseIssues = new();
    private List<StepInfo> _stepInfo = new();
    private bool _loading;
    private int _loadSeq;

    public Controller(Presenter presenter, TtsService tts, AudioPlayer audio, StatusWriter status)
    {
        _presenter = presenter;
        _tts = tts;
        _audio = audio;
        _status = status;
        Player = new Player(tts, audio, this);
        tts.Changed += Changed;
    }

    public Player Player { get; }

    public event Action<ViewSnapshot>? SnapshotChanged;

    /// <summary>Set by the package so a starting tour can bring the walkthrough window into view.</summary>
    public Func<Task>? RevealUi { get; set; }

    /// <summary>The repository or solution folder, for tours outside any <c>.showme</c> folder.</summary>
    public string? WorkspaceRoot { get; set; }

    public bool HasTour => _tour != null;
    public bool IsActive => _loading || Player.State != PlayerState.Idle;

    public async Task PlayFileAsync(string path, int startAt = 0)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        int seq = ++_loadSeq;
        Player.Stop();
        _loading = true;
        _tourPath = Path.GetFullPath(path);
        _tour = null;
        _parseIssues = new List<TourIssue>();
        _stepInfo = new List<StepInfo>();
        Changed();
        Log.Line($"[tour] loading {path}");

        ParseResult parsed;
        try
        {
            parsed = TourParser.ParseText(await ReadWithRetryAsync(path));
        }
        catch (Exception ex)
        {
            parsed = ParseResult.Failed(new TourIssue(null, IssueSeverity.Error, $"Could not read tour file: {ex.Message}"));
        }
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        if (seq != _loadSeq) return;

        _parseIssues = parsed.Issues;
        foreach (var i in parsed.Issues) Log.Line($"[tour] {i.SeverityName}{(i.Step is { } n ? $" (step {n})" : "")}: {i.Message}");
        if (parsed.Tour is not { } tour)
        {
            _loading = false;
            Changed();
            await VS.StatusBar.ShowMessageAsync($"ShowMe: can't play {Path.GetFileName(path)}: {parsed.Issues.FirstOrDefault()?.Message ?? "invalid tour"}");
            return;
        }

        _tour = tour;
        _root = TourPaths.ResolveTourRoot(_tourPath, tour, WorkspaceRoot);
        _stepInfo = tour.Steps.Select(_ => new StepInfo()).ToList();
        Preflight(tour);
        Changed();

        if (RevealUi != null) await RevealUi();
        await _tts.PrepareTourAsync(tour.Steps.Select(s => s.Narration).ToList());
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        if (seq != _loadSeq) return;

        _loading = false;
        Player.Start(tour.Steps.Count, startAt);
    }

    public void ReplayTour()
    {
        if (_tourPath != null) _ = PlayFileAsync(_tourPath);
    }

    public void Goto(int index)
    {
        if (Player.State == PlayerState.Idle)
        {
            if (_tourPath != null) _ = PlayFileAsync(_tourPath, index);
            return;
        }
        Player.Goto(index);
    }

    public void Stop()
    {
        _loadSeq++;
        _loading = false;
        Player.Stop();
    }

    public void Dispose()
    {
        Stop();
        _tts.Changed -= Changed;
    }

    // --- IPlayerHost ---------------------------------------------------------------------------

    public async Task Present(int index)
    {
        var tour = _tour;
        if (tour == null) return;
        var step = tour.Steps[index];
        var result = await _presenter.ShowAsync(new PresentableStep
        {
            Index = index,
            Total = tour.Steps.Count,
            Title = step.Title,
            Narration = step.Narration,
            Path = step.File != null ? StepPath(step.File) : null,
            Lines = step.Lines,
            Anchor = step.Anchor,
        });
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var issue = result.Missing ? $"File not found: {step.File}" : result.Warning;
        if (index < _stepInfo.Count) _stepInfo[index] = new StepInfo { ShownLines = result.ShownLines, Issue = issue };
        if (issue != null) Log.Line($"[tour] step {index + 1}: {issue}");
        Changed();
    }

    public PlayerOptions Options() => new()
    {
        AutoAdvance = General.Instance.AutoAdvance,
        PauseBetweenStepsMs = Math.Max(0, General.Instance.PauseBetweenSteps),
    };

    public void Error(Exception error, int index) => Log.Line($"[player] step {index + 1}: {error.Message}");

    public void Changed()
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        var snap = Snapshot();
        SnapshotChanged?.Invoke(snap);
        if (Player.State == PlayerState.Idle && !_loading) _presenter.Clear();
        if (_tourPath != null && TourPaths.StatusDirFor(_tourPath, WorkspaceRoot) is { } dir) _status.Write(dir, AgentStatus(snap));
    }

    // --- internals -----------------------------------------------------------------------------

    /// <summary>Checks every step up front so the agent sees all problems in status.json right away.</summary>
    private void Preflight(Tour tour)
    {
        for (int i = 0; i < tour.Steps.Count; i++)
        {
            var step = tour.Steps[i];
            if (step.File == null) continue;
            var path = StepPath(step.File);
            if (!File.Exists(path))
            {
                _stepInfo[i] = new StepInfo { Issue = $"File not found: {step.File}" };
                continue;
            }
            if (step.Lines == null) continue;
            try
            {
                var r = AnchorResolver.Resolve(File.ReadAllLines(path), step.Lines[0], step.Lines[1], step.Anchor);
                _stepInfo[i] = new StepInfo { ShownLines = new[] { r.Start, r.End }, Issue = r.Warning };
            }
            catch (Exception ex)
            {
                _stepInfo[i] = new StepInfo { Issue = $"Could not read {step.File}: {ex.Message}" };
            }
        }
    }

    private string StepPath(string file) => TourPaths.ResolveStepPath(_root ?? WorkspaceRoot ?? Path.GetPathRoot(Environment.CurrentDirectory)!, file);

    private ViewSnapshot Snapshot()
    {
        var tour = _tour;
        return new ViewSnapshot
        {
            State = _loading ? "loading" : Player.State.ToString().ToLowerInvariant(),
            Title = tour?.Title,
            TourFile = _tourPath != null ? RelativeToWorkspace(_tourPath) : null,
            Index = Player.Index,
            Total = tour?.Steps.Count ?? 0,
            Steps = (tour?.Steps ?? new List<TourStep>()).Select((s, i) =>
            {
                var shown = (i < _stepInfo.Count ? _stepInfo[i].ShownLines : null) ?? s.Lines;
                return new StepView
                {
                    Title = s.Title ?? FirstWords(s.Narration),
                    Location = s.File == null ? null : s.File + (shown == null ? "" : $":{shown[0]}{(shown[1] != shown[0] ? $"-{shown[1]}" : "")}"),
                    Narration = s.Narration,
                    Issue = i < _stepInfo.Count ? _stepInfo[i].Issue : null,
                };
            }).ToList(),
            Issues = AllIssues(),
            Voice = _tts.Label,
        };
    }

    private List<TourIssue> AllIssues()
    {
        var issues = new List<TourIssue>(_parseIssues);
        for (int i = 0; i < _stepInfo.Count; i++)
        {
            if (_stepInfo[i].Issue is { } issue)
            {
                var severity = issue.StartsWith("File not found", StringComparison.Ordinal) ? IssueSeverity.Error : IssueSeverity.Warning;
                issues.Add(new TourIssue(i + 1, severity, issue));
            }
        }
        return issues;
    }

    /// <summary>What agents read from <c>.showme/status.json</c>. Keep this stable: the skill documents it.</summary>
    private StatusSnapshot AgentStatus(ViewSnapshot snap)
    {
        var tour = _tour;
        var step = tour != null && snap.State is not ("idle" or "loading") && snap.Index < tour.Steps.Count ? tour.Steps[snap.Index] : null;
        var state = snap.State == "idle" ? (tour != null ? "stopped" : _parseIssues.Count > 0 ? "error" : "idle") : snap.State;
        return new StatusSnapshot
        {
            State = state,
            UpdatedAt = DateTime.UtcNow,
            TourFile = snap.TourFile,
            TourTitle = tour?.Title,
            TotalSteps = tour?.Steps.Count ?? 0,
            CurrentStep = step == null ? null : new StepStatus
            {
                Number = snap.Index + 1,
                Title = step.Title,
                File = step.File,
                Lines = step.Lines,
                ShownLines = snap.Index < _stepInfo.Count ? _stepInfo[snap.Index].ShownLines : null,
                Narration = step.Narration,
            },
            Issues = snap.Issues,
        };
    }

    /// <summary>Relative to the folder that contains <c>.showme</c>, like VS Code's asRelativePath.</summary>
    private string RelativeToWorkspace(string path)
    {
        var showme = TourPaths.ShowmeDirOf(path);
        var root = showme != null ? Path.GetDirectoryName(showme) : WorkspaceRoot;
        return root != null ? TourPaths.Relative(root, path) : path;
    }

    private static string FirstWords(string text, int n = 7)
    {
        var words = text.Replace("`", "").Replace("*", "").Replace("_", "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return string.Join(" ", words.Take(n)) + (words.Length > n ? "…" : "");
    }

    /// <summary>The agent may still be writing when the watcher fires.</summary>
    private static async Task<string> ReadWithRetryAsync(string path)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                using var reader = new StreamReader(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete));
                return await reader.ReadToEndAsync();
            }
            catch (IOException) when (attempt < 5)
            {
                await Task.Delay(150);
            }
        }
    }
}
