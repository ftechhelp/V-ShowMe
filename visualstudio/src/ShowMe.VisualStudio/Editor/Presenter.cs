using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using ShowMe.Core.Tours;

namespace ShowMe.VisualStudio.Editor;

internal sealed class PresentableStep
{
    public int Index { get; set; }
    public int Total { get; set; }
    public string? Title { get; set; }
    public string Narration { get; set; } = "";
    public string? Path { get; set; }
    public int[]? Lines { get; set; }
    public string? Anchor { get; set; }
}

internal sealed class PresentResult
{
    /// <summary>Lines actually highlighted (after anchor resolution), 1-based.</summary>
    public int[]? ShownLines { get; set; }

    public string? Warning { get; set; }

    /// <summary>The file could not be opened.</summary>
    public bool Missing { get; set; }
}

/// <summary>
/// Puts a step on screen: opens the file in the preview tab without taking focus (you may be
/// typing to your agent), scrolls the range into view, and sets the highlight and caption that
/// every editor's <see cref="ShowMeAdornment"/> draws. Port of src/editor/presenter.ts.
/// </summary>
internal sealed class Presenter
{
    public async Task<PresentResult> ShowAsync(PresentableStep step)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

        if (step.Path == null)
        {
            // Narration-only step (intro or recap): keep the editor as is, drop the highlight.
            HighlightState.Set(null);
            return new PresentResult();
        }
        if (!File.Exists(step.Path))
        {
            HighlightState.Set(null);
            return new PresentResult { Missing = true };
        }

        var view = await OpenWithoutFocusAsync(step.Path);
        if (view == null)
        {
            HighlightState.Set(null);
            return new PresentResult { Missing = true };
        }

        var snapshot = view.TextSnapshot;
        var result = new PresentResult();
        int start = 0, end = 0;
        bool hasRange = step.Lines != null;
        if (step.Lines != null)
        {
            var lines = snapshot.Lines.Select(l => l.GetText()).ToList();
            var r = AnchorResolver.Resolve(lines, step.Lines[0], step.Lines[1], step.Anchor);
            start = r.Start - 1;
            end = Math.Min(r.End - 1, snapshot.LineCount - 1);
            result.ShownLines = new[] { r.Start, r.End };
            result.Warning = r.Warning;
        }

        var options = General.Instance;
        string header = $"Step {step.Index + 1} of {step.Total}{(step.Title != null ? " · " + step.Title : "")}";
        HighlightState.Set(new HighlightTarget(
            step.Path,
            hasRange ? start : -1,
            hasRange ? end : -1,
            header,
            options.InlineCaptions ? step.Narration : null,
            options.DimOtherLines && hasRange));

        Reveal(view, snapshot, hasRange ? start : 0, hasRange ? end : 0);
        return result;
    }

    public void Clear()
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        HighlightState.Set(null);
    }

    private static void Reveal(IWpfTextView view, ITextSnapshot snapshot, int start, int end)
    {
        var first = snapshot.GetLineFromLineNumber(Math.Max(0, Math.Min(start, snapshot.LineCount - 1)));
        var last = snapshot.GetLineFromLineNumber(Math.Max(0, Math.Min(end, snapshot.LineCount - 1)));
        double visibleLines = view.LineHeight > 0 ? view.ViewportHeight / view.LineHeight : 40;
        bool tall = end - start + 1 > visibleLines - 6;
        if (tall || start == 0)
        {
            view.DisplayTextLineContainingBufferPosition(first.Start, Math.Min(view.LineHeight * 2, view.ViewportHeight / 4), ViewRelativePosition.Top);
        }
        else
        {
            view.ViewScroller.EnsureSpanVisible(new SnapshotSpan(first.Start, last.End), EnsureSpanVisibleOptions.AlwaysCenter);
        }
    }

    /// <summary>Opens <paramref name="path"/> in the preview tab and shows it without activating it.</summary>
    private static async Task<IWpfTextView?> OpenWithoutFocusAsync(string path)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        IVsWindowFrame? frame;
        try
        {
            using (new NewDocumentStateScope(__VSNEWDOCUMENTSTATE.NDS_Provisional, VSConstants.NewDocumentStateReason.Navigation))
            {
                VsShellUtilities.OpenDocument(ServiceProvider.GlobalProvider, path, VSConstants.LOGVIEWID.TextView_guid, out _, out _, out frame);
            }
        }
        catch (Exception ex)
        {
            Log.Line($"[editor] could not open {path}: {ex.Message}");
            return null;
        }
        if (frame == null) return null;
        frame.ShowNoActivate();

        var vsTextView = VsShellUtilities.GetTextView(frame);
        if (vsTextView == null) return null;
        var adapters = await VS.GetMefServiceAsync<IVsEditorAdaptersFactoryService>();
        return adapters.GetWpfTextView(vsTextView);
    }
}
