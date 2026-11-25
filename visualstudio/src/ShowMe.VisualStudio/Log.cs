using System;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;

namespace ShowMe.VisualStudio;

/// <summary>The "ShowMe" pane in the Output window. Safe to call from any thread.</summary>
internal static class Log
{
    private static OutputWindowPane? _pane;

    public static void Line(string text)
    {
        var line = $"{DateTime.Now:HH:mm:ss.fff} {text}";
        System.Diagnostics.Debug.WriteLine("[ShowMe] " + line);
        _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
        {
            try
            {
                _pane ??= await VS.Windows.CreateOutputWindowPaneAsync("ShowMe", lazyCreate: true);
                await _pane.WriteLineAsync(line);
            }
            catch
            {
                // The output window is a convenience; never let logging fail an operation.
            }
        });
    }

    public static void Show() =>
        _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
        {
            _pane ??= await VS.Windows.CreateOutputWindowPaneAsync("ShowMe");
            await _pane.ActivateAsync();
        });
}
