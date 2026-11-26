using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using ShowMe.VisualStudio.Editor;

namespace ShowMe.VisualStudio.UI;

/// <summary>The ShowMe tool window: current caption, playback controls and the clickable step list.</summary>
public sealed class WalkthroughWindow : BaseToolWindow<WalkthroughWindow>
{
    public override string GetTitle(int toolWindowId) => "ShowMe Walkthrough";

    public override Type PaneType => typeof(Pane);

    public override Task<FrameworkElement> CreateAsync(int toolWindowId, CancellationToken cancellationToken)
    {
        var control = new WalkthroughControl();
        ShowMePackage.Instance?.AttachWalkthrough(control);
        return Task.FromResult<FrameworkElement>(control);
    }

    [Guid(PackageGuids.WalkthroughPaneString)]
    internal sealed class Pane : ToolkitToolWindowPane
    {
        public Pane() => BitmapImageMoniker = KnownMonikers.Play;
    }
}

/// <summary>Code-only WPF (no XAML) so the project also compiles off Windows.</summary>
internal sealed class WalkthroughControl : UserControl
{
    private readonly StackPanel _root = new() { Margin = new Thickness(10) };
    private ViewSnapshot? _last;

    public WalkthroughControl()
    {
        SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);
        SetResourceReference(ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
        Themes.SetUseVsTheme(this, true); // VS-styled buttons in light, dark and high-contrast themes
        Content = new ScrollViewer { Content = _root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Render(null);
    }

    /// <summary>Raised for clicks: a command name, or "goto:&lt;index&gt;".</summary>
    public event Action<string>? Action;

    public void Update(ViewSnapshot snapshot)
    {
        _last = snapshot;
        Render(snapshot);
    }

    private void Render(ViewSnapshot? s)
    {
        _root.Children.Clear();
        if (s == null || s.Total == 0 && s.State != "loading")
        {
            RenderEmpty(s);
            return;
        }

        _root.Children.Add(Text(s.Title ?? "Walkthrough", 15, FontWeights.SemiBold));
        var state = s.State == "loading" ? "Loading…" : $"{Capitalize(s.State)} · step {s.Index + 1} of {s.Total}";
        _root.Children.Add(Dim(Text($"{state}  ·  {s.Voice}", 11)));

        if (s.State != "loading")
        {
            var controls = new WrapPanel { Margin = new Thickness(0, 8, 0, 8) };
            bool playing = s.State == "playing";
            controls.Children.Add(Button("⏮", "previous", "Previous step (Ctrl+Shift+Alt+,)", s.Index > 0));
            controls.Children.Add(Button(
                playing ? "⏸ Pause" : s.State == "finished" ? "↻ Again" : s.State == "waiting" ? "▶ Next" : "▶ Resume",
                "togglePause", "Pause / resume (Ctrl+Shift+Alt+Space)", true));
            controls.Children.Add(Button("⏭", "next", "Next step (Ctrl+Shift+Alt+.)", true));
            controls.Children.Add(Button("↻", "replay", "Replay this step", true));
            controls.Children.Add(Button("⏹", "stop", "Stop", true));
            _root.Children.Add(controls);

            if (s.Index < s.Steps.Count)
            {
                var current = s.Steps[s.Index];
                var caption = new Border
                {
                    BorderThickness = new Thickness(3, 0, 0, 0),
                    BorderBrush = new SolidColorBrush(Color.FromRgb(0xff, 0xcc, 0x00)),
                    Padding = new Thickness(8, 6, 8, 6),
                    Margin = new Thickness(0, 0, 0, 10),
                };
                var panel = new StackPanel();
                panel.Children.Add(Text(current.Title, 12, FontWeights.SemiBold));
                var body = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 4) };
                CaptionBubble.AddMarkdown(body.Inlines, current.Narration);
                panel.Children.Add(body);
                if (current.Location != null) panel.Children.Add(Dim(Text(current.Location, 11)));
                caption.Child = panel;
                _root.Children.Add(caption);
            }
        }

        _root.Children.Add(Dim(Text("STEPS", 10, FontWeights.SemiBold)));
        for (int i = 0; i < s.Steps.Count; i++)
        {
            var step = s.Steps[i];
            var item = new StackPanel { Margin = new Thickness(0, 3, 0, 3) };
            var title = Text($"{i + 1}  {step.Title}", 12, i == s.Index ? FontWeights.SemiBold : FontWeights.Normal);
            item.Children.Add(title);
            if (step.Location != null) item.Children.Add(Dim(Text("    " + step.Location, 11)));
            if (step.Issue != null)
            {
                var issue = Text("    ⚠ " + step.Issue, 11);
                issue.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ControlLinkTextBrushKey);
                item.Children.Add(issue);
            }
            var row = new Border { Child = item, Cursor = Cursors.Hand, Background = Brushes.Transparent, Padding = new Thickness(4, 0, 4, 0) };
            if (i == s.Index) row.SetResourceReference(Border.BackgroundProperty, EnvironmentColors.ToolWindowTabMouseOverBackgroundBeginBrushKey);
            int index = i;
            row.MouseLeftButtonUp += (_, _) => Action?.Invoke($"goto:{index}");
            _root.Children.Add(row);
        }

        _root.Children.Add(Dim(Text("Ctrl+Shift+Alt+Space pause · Ctrl+Shift+Alt+, / . step", 10)));
    }

    private void RenderEmpty(ViewSnapshot? s)
    {
        _root.Children.Add(Text("No tour playing", 14, FontWeights.SemiBold));
        var help = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 10) };
        help.Inlines.Add(new Run("Ask your agent to "));
        help.Inlines.Add(new Italic(new Run("show me how … works")));
        help.Inlines.Add(new Run(". It writes a tour into .showme/tours/ and ShowMe plays it here: it opens the files, highlights the code and explains it out loud."));
        _root.Children.Add(help);
        if (s?.Issues.Count > 0)
        {
            foreach (var issue in s.Issues) _root.Children.Add(Text("⚠ " + issue.Message, 11));
        }
        var buttons = new WrapPanel();
        buttons.Children.Add(Button("Play Tour…", "playTour", "Pick a saved tour", true));
        buttons.Children.Add(Button("Install Agent Skill", "installSkill", "Install the show-me skill for your agent", true));
        buttons.Children.Add(Button("Test Voice", "testVoice", "Say a test sentence", true));
        _root.Children.Add(buttons);
    }

    private Button Button(string label, string command, string tooltip, bool enabled)
    {
        var b = new Button { Content = label, ToolTip = tooltip, IsEnabled = enabled, Margin = new Thickness(0, 0, 6, 6), Padding = new Thickness(8, 2, 8, 2), MinWidth = 32 };
        b.Click += (_, _) => Action?.Invoke(command);
        return b;
    }

    private static TextBlock Text(string text, double size, FontWeight? weight = null) =>
        new() { Text = text, FontSize = size, FontWeight = weight ?? FontWeights.Normal, TextWrapping = TextWrapping.Wrap };

    private static TextBlock Dim(TextBlock t)
    {
        t.Opacity = 0.7;
        return t;
    }

    private static string Capitalize(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s.Substring(1);
}
