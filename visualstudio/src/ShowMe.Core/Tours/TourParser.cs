using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ShowMe.Core.Tours;

/// <summary>
/// Tour file format (v1) and a lenient validator. Port of src/tour/schema.ts.
///
/// Tours are written by an agent, so the validator accepts a few common variations
/// (<c>line</c> instead of <c>lines</c>, "12-18" strings, <c>description</c> instead of
/// <c>narration</c>) and reports problems as issues instead of throwing.
/// </summary>
public static class TourParser
{
    public const string InvalidJsonPrefix = "Tour is not valid JSON: ";

    public static ParseResult ParseText(string text)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(text);
        }
        catch (JsonException ex)
        {
            return ParseResult.Failed(new TourIssue(null, IssueSeverity.Error, InvalidJsonPrefix + ex.Message));
        }
        using (doc) return Parse(doc.RootElement);
    }

    public static ParseResult Parse(JsonElement json)
    {
        var issues = new List<TourIssue>();
        if (json.ValueKind != JsonValueKind.Object)
            return ParseResult.Failed(new TourIssue(null, IssueSeverity.Error, "Tour must be a JSON object."));

        var rawSteps = Prop(json, "steps");
        if (rawSteps is not { ValueKind: JsonValueKind.Array } || rawSteps.Value.GetArrayLength() == 0)
            return ParseResult.Failed(new TourIssue(null, IssueSeverity.Error, "Tour must have a non-empty \"steps\" array."));

        var title = FirstString(Prop(json, "title"));
        if (title == null)
        {
            title = "Code walkthrough";
            issues.Add(new TourIssue(null, IssueSeverity.Warning, "Tour has no \"title\"; using \"Code walkthrough\"."));
        }

        var steps = new List<TourStep>();
        int stepNo = 0;
        foreach (var raw in rawSteps.Value.EnumerateArray())
        {
            stepNo++;
            if (raw.ValueKind != JsonValueKind.Object)
            {
                issues.Add(new TourIssue(stepNo, IssueSeverity.Error, "Step must be an object; skipped."));
                continue;
            }

            var narration = FirstString(Prop(raw, "narration"), Prop(raw, "description"), Prop(raw, "text"));
            if (narration == null)
            {
                issues.Add(new TourIssue(stepNo, IssueSeverity.Error, "Step has no \"narration\"; skipped."));
                continue;
            }

            var step = new TourStep(narration) { Title = FirstString(Prop(raw, "title")) };
            var file = FirstString(Prop(raw, "file"), Prop(raw, "path"));
            var rawLines = Prop(raw, "lines") is { ValueKind: not JsonValueKind.Null } l ? l : Prop(raw, "line");
            if (file != null)
            {
                step.File = file;
                var lines = ParseLines(rawLines);
                if (lines.IsInvalid)
                {
                    issues.Add(new TourIssue(stepNo, IssueSeverity.Warning,
                        $"Invalid \"lines\" ({(rawLines.HasValue ? Js.Stringify(rawLines.Value) : "undefined")}); expected [start, end] with 1 <= start <= end. The file will open without a highlight."));
                }
                else if (lines.Range != null)
                {
                    step.Lines = lines.Range;
                }
                step.Anchor = FirstString(Prop(raw, "anchor"));
            }
            else if (Prop(raw, "lines").HasValue || Prop(raw, "line").HasValue)
            {
                issues.Add(new TourIssue(stepNo, IssueSeverity.Warning, "\"lines\" given without \"file\"; ignored."));
            }

            steps.Add(step);
        }

        if (steps.Count == 0)
        {
            issues.Add(new TourIssue(null, IssueSeverity.Error, "No playable steps."));
            return new ParseResult(null, issues);
        }

        var tour = new Tour(title, steps) { Root = FirstString(Prop(json, "root")) };
        return new ParseResult(tour, issues);
    }

    private static readonly Regex LinesText = new(
        "^" + Js.S + "*L?([0-9]+)" + Js.S + "*(?:[-–:]" + Js.S + "*L?([0-9]+))?" + Js.S + "*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>Accepts 12, [12], [12, 18], "12", "12-18", "L12-L18". Absent or null means no lines.</summary>
    public static LinesResult ParseLines(JsonElement? value)
    {
        if (value is not { } v || v.ValueKind == JsonValueKind.Null) return LinesResult.None;

        double? start = null, end = null;
        if (v.ValueKind == JsonValueKind.Number)
        {
            start = end = v.GetDouble();
        }
        else if (v.ValueKind == JsonValueKind.Array && v.GetArrayLength() is >= 1 and <= 2)
        {
            start = Js.ToNumber(v[0]);
            end = v.GetArrayLength() == 2 ? Js.ToNumber(v[1]) : start;
        }
        else if (v.ValueKind == JsonValueKind.String)
        {
            var m = LinesText.Match(v.GetString() ?? "");
            if (m.Success)
            {
                start = Js.StringToNumber(m.Groups[1].Value);
                end = m.Groups[2].Success ? Js.StringToNumber(m.Groups[2].Value) : start;
            }
        }

        if (start is not { } s || end is not { } e || !Js.IsInteger(s) || !Js.IsInteger(e) || s < 1 || e < s || e > int.MaxValue)
            return LinesResult.Invalid;
        return LinesResult.Of((int)s, (int)e);
    }

    /// <summary>The property's value; JSON keeps the last of duplicate keys, like JSON.parse.</summary>
    private static JsonElement? Prop(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) ? v : null;

    /// <summary>The first value that is a non-blank string, trimmed.</summary>
    private static string? FirstString(params JsonElement?[] values)
    {
        foreach (var v in values)
        {
            if (v is { ValueKind: JsonValueKind.String } s)
            {
                var t = Js.Trim(s.GetString() ?? "");
                if (t.Length > 0) return t;
            }
        }
        return null;
    }
}

public readonly struct LinesResult
{
    public static readonly LinesResult None = default;
    public static readonly LinesResult Invalid = new(null, true);
    public static LinesResult Of(int start, int end) => new(new[] { start, end }, false);

    private LinesResult(int[]? range, bool invalid)
    {
        Range = range;
        IsInvalid = invalid;
    }

    /// <summary>[start, end], 1-based inclusive; null when absent or invalid.</summary>
    public int[]? Range { get; }
    public bool IsInvalid { get; }
}
