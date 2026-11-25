using System.Text.Json;
using System.Text.Json.Nodes;
using ShowMe.Core.Speech;
using ShowMe.Core.Tours;

namespace ShowMe.Core.Tests;

/// <summary>
/// Runs the shared behaviour vectors in spec/ (repo root) against the C# port. test/spec.test.ts
/// runs the same files against the TypeScript original, so both extensions behave the same.
/// </summary>
public class SpecTests
{
    private static readonly string SpecDir = FindSpecDir();

    private static string FindSpecDir()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec");
            if (File.Exists(Path.Combine(candidate, "tour.json"))) return candidate;
        }
        throw new InvalidOperationException("spec/ folder not found above " + AppContext.BaseDirectory);
    }

    private static JsonElement Load(string file) => JsonDocument.Parse(File.ReadAllText(Path.Combine(SpecDir, file))).RootElement;

    public static IEnumerable<object[]> Cases(string file, string section)
    {
        int i = 0;
        foreach (var c in Load(file).GetProperty(section).EnumerateArray())
        {
            var label = c.TryGetProperty("name", out var n) ? n.GetString()! : c.GetProperty("input").GetRawText();
            yield return new object[] { $"{i++:00} {Truncate(label)}", c };
        }
    }

    private static string Truncate(string s) => s.Length > 60 ? s.Substring(0, 60) + "…" : s;

    [Theory]
    [MemberData(nameof(Cases), "tour.json", "parseTour")]
    public void ParseTour(string name, JsonElement c)
    {
        _ = name;
        var result = c.TryGetProperty("text", out var text) ? TourParser.ParseText(text.GetString()!) : TourParser.Parse(c.GetProperty("json"));
        var expect = c.GetProperty("expect");

        JsonAssert.Equal(expect.GetProperty("tour"), ToJson(result.Tour));

        var issues = expect.GetProperty("issues").EnumerateArray().ToList();
        Assert.Equal(issues.Count, result.Issues.Count);
        for (int i = 0; i < issues.Count; i++)
        {
            var want = issues[i];
            var got = result.Issues[i];
            Assert.Equal(want.TryGetProperty("step", out var step) ? step.GetInt32() : null, got.Step);
            Assert.Equal(want.GetProperty("severity").GetString(), got.SeverityName);
            if (want.TryGetProperty("messageStartsWith", out var prefix)) Assert.StartsWith(prefix.GetString()!, got.Message);
            else Assert.Equal(want.GetProperty("message").GetString(), got.Message);
        }
    }

    [Theory]
    [MemberData(nameof(Cases), "tour.json", "parseLines")]
    public void ParseLines(string name, JsonElement c)
    {
        _ = name;
        var result = TourParser.ParseLines(c.GetProperty("input"));
        var expect = c.GetProperty("expect");
        if (expect.ValueKind == JsonValueKind.Null)
        {
            Assert.False(result.IsInvalid);
            Assert.Null(result.Range);
        }
        else if (expect.ValueKind == JsonValueKind.String)
        {
            Assert.Equal("invalid", expect.GetString());
            Assert.True(result.IsInvalid);
        }
        else
        {
            Assert.Equal(expect.EnumerateArray().Select(e => e.GetInt32()).ToArray(), result.Range);
        }
    }

    [Theory]
    [MemberData(nameof(Cases), "anchor.json", "resolveRange")]
    public void ResolveRange(string name, JsonElement c)
    {
        _ = name;
        var doc = Load("anchor.json").GetProperty("docs").GetProperty(c.GetProperty("doc").GetString()!)
            .EnumerateArray().Select(e => e.GetString()!).ToList();
        var anchor = c.TryGetProperty("anchor", out var a) ? a.GetString() : null;
        var r = AnchorResolver.Resolve(doc, c.GetProperty("start").GetInt32(), c.GetProperty("end").GetInt32(), anchor);
        var expect = c.GetProperty("expect");
        Assert.Equal(expect.GetProperty("start").GetInt32(), r.Start);
        Assert.Equal(expect.GetProperty("end").GetInt32(), r.End);
        Assert.Equal(expect.TryGetProperty("warning", out var w) ? w.GetString() : null, r.Warning);
    }

    [Theory]
    [MemberData(nameof(Cases), "speech.json", "toSpeech")]
    public void ToSpeech(string name, JsonElement c)
    {
        _ = name;
        Assert.Equal(c.GetProperty("expect").GetString(), SpeechText.ToSpeech(c.GetProperty("input").GetString()!));
    }

    [Theory]
    [MemberData(nameof(Cases), "speech.json", "speakCode")]
    public void SpeakCode(string name, JsonElement c)
    {
        _ = name;
        Assert.Equal(c.GetProperty("expect").GetString(), SpeechText.SpeakCode(c.GetProperty("input").GetString()!));
    }

    [Theory]
    [MemberData(nameof(Cases), "speech.json", "splitIdentifier")]
    public void SplitIdentifier(string name, JsonElement c)
    {
        _ = name;
        Assert.Equal(c.GetProperty("expect").GetString(), SpeechText.SplitIdentifier(c.GetProperty("input").GetString()!));
    }

    [Theory]
    [MemberData(nameof(Cases), "speech.json", "splitSentences")]
    public void SplitSentences(string name, JsonElement c)
    {
        _ = name;
        var expect = c.GetProperty("expect").EnumerateArray().Select(e => e.GetString()!).ToList();
        Assert.Equal(expect, SpeechText.SplitSentences(c.GetProperty("input").GetString()!));
    }

    [Theory]
    [MemberData(nameof(Cases), "speech.json", "readingTimeMs")]
    public void ReadingTimeMs(string name, JsonElement c)
    {
        _ = name;
        Assert.Equal(c.GetProperty("expect").GetInt32(), SpeechText.ReadingTimeMs(c.GetProperty("input").GetString()!));
    }

    /// <summary>The tour as the TypeScript side would serialize it (absent fields left out).</summary>
    private static JsonNode? ToJson(Tour? tour)
    {
        if (tour == null) return null;
        var steps = new JsonArray();
        foreach (var s in tour.Steps)
        {
            var step = new JsonObject { ["narration"] = s.Narration };
            if (s.Title != null) step["title"] = s.Title;
            if (s.File != null) step["file"] = s.File;
            if (s.Lines != null) step["lines"] = new JsonArray(s.Lines.Select(n => (JsonNode)n).ToArray());
            if (s.Anchor != null) step["anchor"] = s.Anchor;
            steps.Add(step);
        }
        var obj = new JsonObject { ["version"] = tour.Version, ["title"] = tour.Title, ["steps"] = steps };
        if (tour.Root != null) obj["root"] = tour.Root;
        return obj;
    }
}

internal static class JsonAssert
{
    /// <summary>Structural equality; object key order doesn't matter.</summary>
    public static void Equal(JsonElement expected, JsonNode? actual)
    {
        var actualElement = actual == null ? JsonDocument.Parse("null").RootElement : JsonDocument.Parse(actual.ToJsonString()).RootElement;
        if (!Same(expected, actualElement))
            Assert.Fail($"JSON differs.\nExpected: {expected.GetRawText()}\nActual:   {actualElement.GetRawText()}");
    }

    private static bool Same(JsonElement a, JsonElement b)
    {
        if (a.ValueKind != b.ValueKind) return false;
        switch (a.ValueKind)
        {
            case JsonValueKind.Object:
                var ap = a.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                var bp = b.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                return ap.Count == bp.Count && ap.All(kv => bp.TryGetValue(kv.Key, out var v) && Same(kv.Value, v));
            case JsonValueKind.Array:
                var aa = a.EnumerateArray().ToList();
                var ba = b.EnumerateArray().ToList();
                return aa.Count == ba.Count && aa.Zip(ba).All(t => Same(t.First, t.Second));
            case JsonValueKind.Number:
                return a.GetDouble() == b.GetDouble();
            case JsonValueKind.String:
                return a.GetString() == b.GetString();
            default:
                return true;
        }
    }
}
