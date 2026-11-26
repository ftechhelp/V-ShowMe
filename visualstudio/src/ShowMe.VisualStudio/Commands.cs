using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using ShowMe.Core.Playback;
using ShowMe.Core.Skills;
using ShowMe.Core.Status;
using ShowMe.VisualStudio.UI;
using ShowMe.VisualStudio.Workspace;

namespace ShowMe.VisualStudio;

/// <summary>Tools › ShowMe commands. Playback commands are enabled while a tour is active.</summary>
internal static class Commands
{
    private static ShowMePackage? Package => ShowMePackage.Instance;

    internal static bool TourActive => Package?.Controller is { IsActive: true };

    /// <summary>Opens a file picker in the newest <c>.showme/tours</c> folder.</summary>
    public static async Task PickAndPlayAsync(ShowMePackage package)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var newest = package.Watcher.ListTours().FirstOrDefault();
        var startDir = newest.Path != null
            ? Path.GetDirectoryName(newest.Path)
            : package.Watcher.Roots.Select(TourPaths.ToursDir).FirstOrDefault(Directory.Exists) ?? package.Watcher.Roots.LastOrDefault();
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "ShowMe: play a tour",
            Filter = "ShowMe tour (*.json)|*.json",
            InitialDirectory = startDir ?? "",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog() == true) await package.Controller.PlayFileAsync(dialog.FileName);
    }

    public static async Task InstallSkillAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var dialog = new InstallSkillDialog();
        if (dialog.ShowModal() != true) return;
        try
        {
            var root = dialog.Project
                ? WorkspaceRoots.Primary(await WorkspaceRoots.CurrentAsync())
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (string.IsNullOrEmpty(root))
            {
                await VS.MessageBox.ShowErrorAsync("ShowMe", "Open a solution or folder before installing a project skill.");
                return;
            }
            var source = Path.Combine(Path.GetDirectoryName(typeof(ShowMePackage).Assembly.Location)!, "skill", "show-me");
            var target = SkillInstaller.Destination(root!, dialog.Target, dialog.Project);
            if (Directory.Exists(target) || File.Exists(target))
            {
                if (!await VS.MessageBox.ShowConfirmAsync("ShowMe", $"A \"show-me\" skill already exists at {target}. Replace it with the version bundled in this extension?")) return;
            }
            SkillInstaller.Install(source, target);
            await VS.MessageBox.ShowAsync("ShowMe", $"Skill installed at {target}. Ask your agent: \"show me how … works\".");
        }
        catch (Exception ex)
        {
            await VS.MessageBox.ShowErrorAsync("ShowMe", $"Could not install the skill: {ex.Message}");
        }
    }

    public static async Task TestVoiceAsync(ShowMePackage package)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        try
        {
            await VS.StatusBar.ShowMessageAsync("ShowMe: preparing voice…");
            var clips = await package.Tts.SpeakOnceAsync("Hi! I'm your ShowMe narrator. Ask your agent to show you some code, and I'll walk you through it.");
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            await VS.StatusBar.ShowMessageAsync($"ShowMe voice: {package.Tts.Label}");
            foreach (var clip in clips) await package.Audio.Play(clip);
        }
        catch (Exception ex)
        {
            await VS.MessageBox.ShowErrorAsync("ShowMe", $"Voice test failed: {ex.Message}");
        }
    }
}

[Command(PackageGuids.CmdSetString, PackageIds.OpenWalkthrough)]
internal sealed class OpenWalkthroughCommand : BaseCommand<OpenWalkthroughCommand>
{
    protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => WalkthroughWindow.ShowAsync();
}

[Command(PackageGuids.CmdSetString, PackageIds.PlayTour)]
internal sealed class PlayTourCommand : BaseCommand<PlayTourCommand>
{
    protected override Task ExecuteAsync(OleMenuCmdEventArgs e) =>
        ShowMePackage.Instance is { } p ? Commands.PickAndPlayAsync(p) : Task.CompletedTask;
}

/// <summary>Base for commands that only make sense while a tour is active.</summary>
internal abstract class PlaybackCommand<T> : BaseCommand<T> where T : class, new()
{
    protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = Commands.TourActive;

    protected override Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        if (ShowMePackage.Instance is { } p && Commands.TourActive) Run(p);
        return Task.CompletedTask;
    }

    protected abstract void Run(ShowMePackage package);
}

[Command(PackageGuids.CmdSetString, PackageIds.TogglePause)]
internal sealed class TogglePauseCommand : PlaybackCommand<TogglePauseCommand>
{
    protected override void Run(ShowMePackage p) => p.Controller.Player.TogglePause();
}

[Command(PackageGuids.CmdSetString, PackageIds.Next)]
internal sealed class NextCommand : PlaybackCommand<NextCommand>
{
    protected override void Run(ShowMePackage p) => p.Controller.Player.Next();
}

[Command(PackageGuids.CmdSetString, PackageIds.Previous)]
internal sealed class PreviousCommand : PlaybackCommand<PreviousCommand>
{
    protected override void Run(ShowMePackage p) => p.Controller.Player.Previous();
}

[Command(PackageGuids.CmdSetString, PackageIds.Replay)]
internal sealed class ReplayCommand : PlaybackCommand<ReplayCommand>
{
    protected override void Run(ShowMePackage p) => p.Controller.Player.Replay();
}

[Command(PackageGuids.CmdSetString, PackageIds.Stop)]
internal sealed class StopCommand : PlaybackCommand<StopCommand>
{
    protected override void Run(ShowMePackage p) => p.Controller.Stop();
}

[Command(PackageGuids.CmdSetString, PackageIds.ReplayTour)]
internal sealed class ReplayTourCommand : BaseCommand<ReplayTourCommand>
{
    protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = ShowMePackage.Instance?.Controller.HasTour == true;

    protected override Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        ShowMePackage.Instance?.Controller.ReplayTour();
        return Task.CompletedTask;
    }
}

[Command(PackageGuids.CmdSetString, PackageIds.InstallSkill)]
internal sealed class InstallSkillCommand : BaseCommand<InstallSkillCommand>
{
    protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => Commands.InstallSkillAsync();
}

[Command(PackageGuids.CmdSetString, PackageIds.TestVoice)]
internal sealed class TestVoiceCommand : BaseCommand<TestVoiceCommand>
{
    protected override Task ExecuteAsync(OleMenuCmdEventArgs e) =>
        ShowMePackage.Instance is { } p ? Commands.TestVoiceAsync(p) : Task.CompletedTask;
}
