using System;
using System.IO;

namespace ShowMe.VisualStudio.Editor;

/// <summary>What ShowMe is pointing at right now. Every open editor watches this and redraws.</summary>
internal sealed class HighlightTarget
{
    public HighlightTarget(string filePath, int startLine, int endLine, string? captionHeader, string? captionBody, bool dim)
    {
        FilePath = filePath;
        StartLine = startLine;
        EndLine = endLine;
        CaptionHeader = captionHeader;
        CaptionBody = captionBody;
        Dim = dim;
    }

    public string FilePath { get; }

    /// <summary>0-based, inclusive.</summary>
    public int StartLine { get; }

    /// <summary>0-based, inclusive.</summary>
    public int EndLine { get; }

    public string? CaptionHeader { get; }

    /// <summary>Light Markdown. Null when inline captions are off.</summary>
    public string? CaptionBody { get; }

    public bool Dim { get; }

    public bool IsFor(string? path) =>
        path != null && string.Equals(Normalize(path), Normalize(FilePath), StringComparison.OrdinalIgnoreCase);

    private static string Normalize(string path)
    {
        try
        {
            return Path.GetFullPath(path);
        }
        catch (Exception)
        {
            return path;
        }
    }
}

/// <summary>UI thread only.</summary>
internal static class HighlightState
{
    public static HighlightTarget? Current { get; private set; }

    public static event Action? Changed;

    public static void Set(HighlightTarget? target)
    {
        Current = target;
        Changed?.Invoke();
    }
}
