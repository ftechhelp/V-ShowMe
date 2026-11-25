using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using ShowMe.Core.Playback;
using ShowMe.VisualStudio.Editor;
using ShowMe.VisualStudio.Speech;
using ShowMe.VisualStudio.UI;
using ShowMe.VisualStudio.Workspace;
using Task = System.Threading.Tasks.Task;

namespace ShowMe.VisualStudio;

/// <summary>
/// Loads in the background once Visual Studio has started, watches the open solution or folder
/// for tours, and wires the controller to the editor, voice, walkthrough window and status bar.
/// Port of src/extension.ts.
/// </summary>
[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[InstalledProductRegistration(Vsix.Name, Vsix.Description, Vsix.Version)]
[ProvideMenuResource("Menus.ctmenu", 1)]
[ProvideToolWindow(typeof(WalkthroughWindow.Pane), Style = VsDockStyle.Tabbed, Window = WindowGuids.SolutionExplorer)]
[ProvideOptionPage(typeof(OptionsProvider.GeneralOptions), "ShowMe", "General", 0, 0, true, SupportsProfiles = true)]
[ProvideAutoLoad(VSConstants.UICONTEXT.ShellInitialized_string, PackageAutoLoadFlags.BackgroundLoad)]
[Guid(PackageGuids.PackageString)]
public sealed class ShowMePackage : ToolkitPackage
{
    internal static ShowMePackage? Instance { get; private set; }

    internal Controller Controller { get; private set; } = null!;
    internal TtsService Tts { get; private set; } = null!;
    internal AudioPlayer Audio { get; private set; } = null!;
    internal TourWatcher Watcher { get; private set; } = null!;
    internal string StorageDir { get; private set; } = "";

    private StatusWriter? _status;
    private WalkthroughControl? _walkthrough;
    private ViewSnapshot? _lastSnapshot;
    private string? _lastStatusText;

    protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
    {
        await this.RegisterCommandsAsync();
        this.RegisterToolWindows();
        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);

        Instance = this;
        StorageDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ShowMe");
        Directory.CreateDirectory(StorageDir);

        Tts = new TtsService(StorageDir);
        Audio = new AudioPlayer();
        _status = new StatusWriter();
        Controller = new Controller(new Presenter(), Tts, Audio, _status) { RevealUi = RevealWalkthroughAsync };
        Controller.SnapshotChanged += OnSnapshot;
        Watcher = new TourWatcher(path => _ = JoinableTaskFactory.RunAsync(() => OnTourWrittenAsync(path)));

        VS.Events.SolutionEvents.OnAfterOpenSolution += solution => RefreshRootsLater();
        VS.Events.SolutionEvents.OnAfterOpenFolder += folder => RefreshRootsLater();
        VS.Events.SolutionEvents.OnAfterCloseSolution += RefreshRootsLater;
        VS.Events.SolutionEvents.OnAfterCloseFolder += folder => RefreshRootsLater();
        await RefreshRootsAsync();

        Log.Line($"[showme] loaded (Visual Studio, {KokoroHostInstaller.RuntimeId}, storage {StorageDir})");
        await PlayRecentTourAsync();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Watcher?.Dispose();
            Controller?.Dispose();
            Audio?.Dispose();
            Tts?.Dispose();
            _status?.Dispose();
        }
        base.Dispose(disposing);
    }

    internal void AttachWalkthrough(WalkthroughControl control)
    {
        _walkthrough = control;
        control.Action += OnWalkthroughAction;
        if (_lastSnapshot != null) control.Update(_lastSnapshot);
    }

    private async Task RevealWalkthroughAsync()
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync();
        // Show it without taking focus away from whatever the user is typing in.
        var pane = await FindToolWindowAsync(typeof(WalkthroughWindow.Pane), 0, true, DisposalToken);
        if (pane?.Frame is Microsoft.VisualStudio.Shell.Interop.IVsWindowFrame frame) frame.ShowNoActivate();
    }

    private void RefreshRootsLater() => _ = JoinableTaskFactory.RunAsync(RefreshRootsAsync);

    private async Task RefreshRootsAsync()
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync();
        var roots = await WorkspaceRoots.CurrentAsync();
        Watcher.SetRoots(roots);
        Controller.WorkspaceRoot = WorkspaceRoots.Primary(roots);
        if (roots.Count > 0) Log.Line($"[watch] workspace roots: {string.Join(", ", roots)}");
    }

    private async Task OnTourWrittenAsync(string path)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync();
        if (!General.Instance.AutoPlayNewTours) return;
        Log.Line($"[watch] new tour {path}");
        await Controller.PlayFileAsync(path);
    }

    /// <summary>A tour written while Visual Studio was still starting would otherwise be missed.</summary>
    private async Task PlayRecentTourAsync()
    {
        if (!General.Instance.AutoPlayNewTours) return;
        var newest = Watcher.ListTours().FirstOrDefault();
        if (newest.Path != null && DateTime.UtcNow - newest.Modified < TimeSpan.FromSeconds(30) && !Controller.HasTour)
        {
            Log.Line($"[watch] playing tour written during startup: {newest.Path}");
            await Controller.PlayFileAsync(newest.Path);
        }
    }

    private void OnSnapshot(ViewSnapshot snapshot)
    {
        _lastSnapshot = snapshot;
        _walkthrough?.Update(snapshot);
        var text = snapshot.State == "idle"
            ? null
            : snapshot.State == "loading" ? "ShowMe: loading tour…" : $"ShowMe {snapshot.Index + 1}/{snapshot.Total} · {snapshot.State}";
        if (text != _lastStatusText)
        {
            _lastStatusText = text;
            _ = VS.StatusBar.ShowMessageAsync(text ?? "");
        }
    }

    private void OnWalkthroughAction(string action)
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        if (action.StartsWith("goto:", StringComparison.Ordinal))
        {
            Controller.Goto(int.Parse(action.Substring(5)));
            return;
        }
        switch (action)
        {
            case "previous": Controller.Player.Previous(); break;
            case "next": Controller.Player.Next(); break;
            case "togglePause": Controller.Player.TogglePause(); break;
            case "replay": Controller.Player.Replay(); break;
            case "stop": Controller.Stop(); break;
            case "playTour": _ = JoinableTaskFactory.RunAsync(() => Commands.PickAndPlayAsync(this)); break;
            case "installSkill": _ = JoinableTaskFactory.RunAsync(() => Commands.InstallSkillAsync()); break;
            case "testVoice": _ = JoinableTaskFactory.RunAsync(() => Commands.TestVoiceAsync(this)); break;
        }
    }
}
