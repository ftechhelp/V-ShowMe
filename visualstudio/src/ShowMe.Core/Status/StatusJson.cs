using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using ShowMe.Core.Tours;

namespace ShowMe.Core.Status;

/// <summary>What the agent sees in <c>.showme/status.json</c>.</summary>
public sealed class StatusSnapshot
{
    /// <summary>loading | playing | paused | waiting | finished | stopped | error | idle</summary>
    public string State { get; set; } = "idle";

    /// <summary>Workspace-relative tour path; null when no tour was ever loaded.</summary>
    public string? TourFile { get; set; }

    public string? TourTitle { get; set; }
    public int TotalSteps { get; set; }
    public StepStatus? CurrentStep { get; set; }
    public IReadOnlyList<TourIssue> Issues { get; set; } = Array.Empty<TourIssue>();
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class StepStatus
{
    /// <summary>1-based.</summary>
    public int Number { get; set; }

    public string? Title { get; set; }
    public string? File { get; set; }
    public int[]? Lines { get; set; }
    public int[]? ShownLines { get; set; }
    public string Narration { get; set; } = "";
}

/// <summary>
/// Writes status.json in exactly the shape the VS Code extension writes (controller.ts,
/// agentStatus) and skill/show-me/reference/tour-format.md documents. Agents depend on it.
/// </summary>
public static class StatusJson
{
    public const string About = "Written by the ShowMe VS Code extension. Shows what the user is looking at. Do not edit.";

    public static string Serialize(StatusSnapshot s, string about = About)
    {
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartObject();
            w.WriteString("about", about);
            w.WriteString("updatedAt", s.UpdatedAt.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            w.WriteString("state", s.State);

            if (s.TourFile != null)
            {
                w.WriteStartObject("tour");
                w.WriteString("file", s.TourFile);
                WriteStringOrNull(w, "title", s.TourTitle);
                w.WriteNumber("totalSteps", s.TotalSteps);
                w.WriteEndObject();
            }
            else
            {
                w.WriteNull("tour");
            }

            if (s.CurrentStep is { } step)
            {
                w.WriteStartObject("currentStep");
                w.WriteNumber("number", step.Number);
                WriteStringOrNull(w, "title", step.Title);
                WriteStringOrNull(w, "file", step.File);
                WriteRange(w, "lines", step.Lines);
                WriteRange(w, "shownLines", step.ShownLines);
                w.WriteString("narration", step.Narration);
                w.WriteEndObject();
            }
            else
            {
                w.WriteNull("currentStep");
            }

            w.WriteStartArray("issues");
            foreach (var issue in s.Issues)
            {
                w.WriteStartObject();
                if (issue.Step is { } n) w.WriteNumber("step", n);
                w.WriteString("severity", issue.SeverityName);
                w.WriteString("message", issue.Message);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray()).Replace("\r\n", "\n") + "\n";
    }

    private static void WriteStringOrNull(Utf8JsonWriter w, string name, string? value)
    {
        if (value != null) w.WriteString(name, value);
        else w.WriteNull(name);
    }

    private static void WriteRange(Utf8JsonWriter w, string name, int[]? range)
    {
        if (range == null)
        {
            w.WriteNull(name);
            return;
        }
        w.WriteStartArray(name);
        foreach (var n in range) w.WriteNumberValue(n);
        w.WriteEndArray();
    }
}
