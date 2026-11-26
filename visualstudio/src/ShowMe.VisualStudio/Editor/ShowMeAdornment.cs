using System;
using System.ComponentModel.Composition;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Classification;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Formatting;
using Microsoft.VisualStudio.Utilities;

namespace ShowMe.VisualStudio.Editor;

/// <summary>
/// Draws ShowMe in one editor: a highlight with a left border behind the current lines, a
/// translucent veil over the other lines (the VS Code version fades them), and the caption bubble
/// in space that <see cref="CaptionLineTransformSource"/> opens up below the last highlighted line.
/// </summary>
internal sealed class ShowMeAdornment
{
    public const string UnderLayer = "ShowMe.Under";
    public const string OverLayer = "ShowMe.Over";
    private const double CaptionMargin = 6;

    private readonly IWpfTextView _view;
    private readonly IEditorFormatMap _formatMap;
    private readonly IAdornmentLayer _under;
    private readonly IAdornmentLayer _over;
    private CaptionBubble? _bubble;
    private double _bubbleWidth;
    private double _bubbleHeight;

    private ShowMeAdornment(IWpfTextView view, IEditorFormatMap formatMap)
    {
        _view = view;
        _formatMap = formatMap;
        _under = view.GetAdornmentLayer(UnderLayer);
        _over = view.GetAdornmentLayer(OverLayer);
        view.LayoutChanged += OnLayoutChanged;
        view.ViewportWidthChanged += OnViewportWidthChanged;
        view.Closed += OnClosed;
        HighlightState.Changed += OnStateChanged;
        RebuildCaption();
    }

    public static ShowMeAdornment For(IWpfTextView view, IEditorFormatMap formatMap) =>
        view.Properties.GetOrCreateSingletonProperty(() => new ShowMeAdornment(view, formatMap));

    private string? FilePath =>
        _view.TextBuffer.Properties.TryGetProperty(typeof(ITextDocument), out ITextDocument doc) ? doc.FilePath : null;

    private HighlightTarget? Target => HighlightState.Current is { } t && t.IsFor(FilePath) ? t : null;

    /// <summary>Extra space the caption needs below <paramref name="line"/>, or 0.</summary>
    public double CaptionSpaceBelow(ITextViewLine line)
    {
        if (_bubble == null || Target is not { } t) return 0;
        if (!line.IsLastTextViewLineForSnapshotLine) return 0;
        int lineNo = line.Start.GetContainingLine().LineNumber;
        return lineNo == CaptionLine(t) ? _bubbleHeight + 2 * CaptionMargin : 0;
    }

    /// <summary>Under the last highlighted line; under the first line when the step has no range.</summary>
    private int CaptionLine(HighlightTarget t) => Math.Max(0, Math.Min(t.EndLine, _view.TextSnapshot.LineCount - 1));

    private void OnStateChanged()
    {
        if (_view.IsClosed) return;
        RebuildCaption();
        ForceRelayout();
        Redraw();
    }

    private void OnViewportWidthChanged(object sender, EventArgs e)
    {
        if (_bubble == null || Math.Abs(BubbleWidth() - _bubbleWidth) < 1) return;
        RebuildCaption();
        ForceRelayout();
    }

    private void OnLayoutChanged(object sender, TextViewLayoutChangedEventArgs e) => Redraw();

    private void OnClosed(object sender, EventArgs e)
    {
        HighlightState.Changed -= OnStateChanged;
        _view.LayoutChanged -= OnLayoutChanged;
        _view.ViewportWidthChanged -= OnViewportWidthChanged;
        _view.Closed -= OnClosed;
    }

    private double BubbleWidth() => Math.Max(200, Math.Min(900, _view.ViewportWidth - 48));

    private void RebuildCaption()
    {
        var t = Target;
        if (t?.CaptionBody == null)
        {
            _bubble = null;
            _bubbleHeight = 0;
            return;
        }
        _bubbleWidth = BubbleWidth();
        _bubble = new CaptionBubble(t.CaptionHeader ?? "", t.CaptionBody, Colors().Border) { Width = _bubbleWidth };
        _bubble.Measure(new Size(_bubbleWidth, double.PositiveInfinity));
        _bubbleHeight = Math.Ceiling(_bubble.DesiredSize.Height);
    }

    /// <summary>Makes the editor ask the line transform source again, so the caption space appears or goes.</summary>
    private void ForceRelayout()
    {
        var lines = _view.TextViewLines;
        if (lines == null || _view.InLayout) return;
        var first = lines.FirstVisibleLine;
        _view.DisplayTextLineContainingBufferPosition(first.Start, first.Top - _view.ViewportTop, ViewRelativePosition.Top);
    }

    private void Redraw()
    {
        _under.RemoveAllAdornments();
        _over.RemoveAllAdornments();
        if (Target is not { } t || _view.TextViewLines == null) return;

        var colors = Colors();
        foreach (var line in _view.TextViewLines)
        {
            int lineNo = line.Start.GetContainingLine().LineNumber;
            var span = new SnapshotSpan(line.Start, line.EndIncludingLineBreak);
            if (lineNo >= t.StartLine && lineNo <= t.EndLine)
            {
                AddRect(_under, span, line.TextTop, line.TextHeight, colors.Background, colors.Border);
            }
            else if (t.Dim)
            {
                var veil = AddRect(_over, span, line.TextTop, line.TextHeight, colors.Veil, null);
                veil.Opacity = 0.55;
            }

            if (_bubble != null && lineNo == CaptionLine(t) && line.IsLastTextViewLineForSnapshotLine)
            {
                if (_bubble.Parent is Panel p) p.Children.Remove(_bubble);
                Canvas.SetLeft(_bubble, _view.ViewportLeft + 24);
                Canvas.SetTop(_bubble, line.TextBottom + CaptionMargin);
                _over.AddAdornment(AdornmentPositioningBehavior.TextRelative, span, "caption", _bubble, null);
            }
        }
    }

    private Rectangle AddRect(IAdornmentLayer layer, SnapshotSpan span, double top, double height, Brush fill, Brush? border)
    {
        var rect = new Rectangle { Width = Math.Max(_view.ViewportWidth, 1), Height = Math.Max(height, 1), Fill = fill, IsHitTestVisible = false };
        Canvas.SetLeft(rect, _view.ViewportLeft);
        Canvas.SetTop(rect, top);
        layer.AddAdornment(AdornmentPositioningBehavior.TextRelative, span, null, rect, null);
        if (border != null)
        {
            var bar = new Rectangle { Width = 3, Height = Math.Max(height, 1), Fill = border, IsHitTestVisible = false };
            Canvas.SetLeft(bar, _view.ViewportLeft);
            Canvas.SetTop(bar, top);
            layer.AddAdornment(AdornmentPositioningBehavior.TextRelative, span, null, bar, null);
        }
        return rect;
    }

    private (Brush Background, Brush Border, Brush Veil) Colors()
    {
        var bg = _formatMap.GetProperties("TextView Background")[EditorFormatDefinition.BackgroundBrushId] as SolidColorBrush
                 ?? _view.Background as SolidColorBrush
                 ?? Brushes.White;
        var c = bg.Color;
        bool dark = 0.299 * c.R + 0.587 * c.G + 0.114 * c.B < 128;
        // Same colors as showme.highlightBackground / showme.highlightBorder in VS Code.
        var highlight = new SolidColorBrush(dark ? Color.FromArgb(0x2b, 0xff, 0xd5, 0x00) : Color.FromArgb(0x42, 0xff, 0xd5, 0x00));
        var border = new SolidColorBrush(dark ? Color.FromRgb(0xff, 0xcc, 0x00) : Color.FromRgb(0xc9, 0x97, 0x00));
        var veil = new SolidColorBrush(c);
        highlight.Freeze();
        border.Freeze();
        veil.Freeze();
        return (highlight, border, veil);
    }
}

/// <summary>MEF exports that attach <see cref="ShowMeAdornment"/> to every document editor.</summary>
[Export(typeof(IWpfTextViewCreationListener))]
[ContentType("text")]
[TextViewRole(PredefinedTextViewRoles.Document)]
internal sealed class ShowMeViewListener : IWpfTextViewCreationListener
{
#pragma warning disable CS0169, CS0649, IDE0044, IDE0051 // MEF reads these definitions through reflection.
    [Export(typeof(AdornmentLayerDefinition))]
    [Name(ShowMeAdornment.UnderLayer)]
    [Order(After = PredefinedAdornmentLayers.Selection, Before = PredefinedAdornmentLayers.Text)]
    private AdornmentLayerDefinition? _underLayer;

    [Export(typeof(AdornmentLayerDefinition))]
    [Name(ShowMeAdornment.OverLayer)]
    [Order(After = PredefinedAdornmentLayers.Caret)]
    private AdornmentLayerDefinition? _overLayer;
#pragma warning restore CS0169, CS0649, IDE0044, IDE0051

    [Import]
    internal IEditorFormatMapService FormatMapService { get; set; } = null!;

    public void TextViewCreated(IWpfTextView textView) => ShowMeAdornment.For(textView, FormatMapService.GetEditorFormatMap(textView));
}

[Export(typeof(ILineTransformSourceProvider))]
[ContentType("text")]
[TextViewRole(PredefinedTextViewRoles.Document)]
internal sealed class CaptionLineTransformSourceProvider : ILineTransformSourceProvider
{
    [Import]
    internal IEditorFormatMapService FormatMapService { get; set; } = null!;

    public ILineTransformSource Create(IWpfTextView textView) =>
        new CaptionLineTransformSource(ShowMeAdornment.For(textView, FormatMapService.GetEditorFormatMap(textView)));
}

/// <summary>Opens vertical space below the last highlighted line for the caption bubble.</summary>
internal sealed class CaptionLineTransformSource : ILineTransformSource
{
    private readonly ShowMeAdornment _adornment;

    public CaptionLineTransformSource(ShowMeAdornment adornment) => _adornment = adornment;

    public LineTransform GetLineTransform(ITextViewLine line, double yPosition, ViewRelativePosition placement)
    {
        // Build on the default (not the current) transform, or the space would grow with every layout.
        var d = line.DefaultLineTransform;
        double extra = _adornment.CaptionSpaceBelow(line);
        return extra > 0 ? new LineTransform(d.TopSpace, d.BottomSpace + extra, d.VerticalScale, d.Right) : d;
    }
}
