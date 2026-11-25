using System.Collections.Generic;

namespace ShowMe.Core.Tours;

public sealed class Tour
{
    public Tour(string title, List<TourStep> steps)
    {
        Title = title;
        Steps = steps;
    }

    public int Version => 1;
    public string Title { get; }

    /// <summary>Optional directory, relative to the tour file, that step paths resolve against.</summary>
    public string? Root { get; set; }

    public List<TourStep> Steps { get; }
}

public sealed class TourStep
{
    public TourStep(string narration) => Narration = narration;

    /// <summary>What gets said (and shown as the caption). Light Markdown.</summary>
    public string Narration { get; }

    /// <summary>Short label for the step list.</summary>
    public string? Title { get; set; }

    /// <summary>Path relative to the tour root (normally the workspace folder).</summary>
    public string? File { get; set; }

    /// <summary>[start, end], 1-based inclusive. Only set when <see cref="File"/> is.</summary>
    public int[]? Lines { get; set; }

    /// <summary>Text expected on the first highlighted line, used to re-locate drifted ranges.</summary>
    public string? Anchor { get; set; }
}

public enum IssueSeverity
{
    Error,
    Warning,
}

public sealed class TourIssue
{
    public TourIssue(int? step, IssueSeverity severity, string message)
    {
        Step = step;
        Severity = severity;
        Message = message;
    }

    /// <summary>1-based step number; null for tour-level issues.</summary>
    public int? Step { get; }
    public IssueSeverity Severity { get; }
    public string Message { get; }

    /// <summary>"error" or "warning", as written to status.json.</summary>
    public string SeverityName => Severity == IssueSeverity.Error ? "error" : "warning";
}

public sealed class ParseResult
{
    public ParseResult(Tour? tour, List<TourIssue> issues)
    {
        Tour = tour;
        Issues = issues;
    }

    public static ParseResult Failed(TourIssue issue) => new(null, new List<TourIssue> { issue });

    public Tour? Tour { get; }
    public List<TourIssue> Issues { get; }
}
