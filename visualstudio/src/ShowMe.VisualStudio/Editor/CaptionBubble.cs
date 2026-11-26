using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;

namespace ShowMe.VisualStudio.Editor;

/// <summary>The narration shown under the highlighted code, like the VS Code comment bubble.</summary>
internal sealed class CaptionBubble : Border
{
    public CaptionBubble(string header, string markdown, Brush accent)
    {
        BorderThickness = new Thickness(1, 1, 1, 1);
        CornerRadius = new CornerRadius(4);
        Padding = new Thickness(12, 8, 12, 10);
        BorderBrush = accent;
        SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);

        var title = new TextBlock
        {
            Text = header,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 0, 0, 4),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        title.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);

        var body = new TextBlock { TextWrapping = TextWrapping.Wrap };
        body.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
        AddMarkdown(body.Inlines, markdown);

        var panel = new StackPanel();
        panel.Children.Add(title);
        panel.Children.Add(body);
        Child = panel;

        SetResourceReference(TextElement.FontFamilyProperty, VsFonts.EnvironmentFontFamilyKey);
        SetResourceReference(TextElement.FontSizeProperty, VsFonts.EnvironmentFontSizeKey);
        IsHitTestVisible = false;
    }

    private static readonly Regex Token = new(@"`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_");

    /// <summary>The light Markdown the tour format allows: `code`, **bold**, *italic*.</summary>
    internal static void AddMarkdown(InlineCollection inlines, string markdown)
    {
        int pos = 0;
        foreach (Match m in Token.Matches(markdown))
        {
            if (m.Index > pos) inlines.Add(new Run(markdown.Substring(pos, m.Index - pos)));
            if (m.Groups[1].Success)
            {
                inlines.Add(new Run(m.Groups[1].Value) { FontFamily = new FontFamily("Cascadia Mono, Consolas, Courier New") });
            }
            else if (m.Groups[2].Success || m.Groups[3].Success)
            {
                inlines.Add(new Bold(new Run(m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value)));
            }
            else
            {
                inlines.Add(new Italic(new Run(m.Groups[4].Success ? m.Groups[4].Value : m.Groups[5].Value)));
            }
            pos = m.Index + m.Length;
        }
        if (pos < markdown.Length) inlines.Add(new Run(markdown.Substring(pos)));
    }
}
