using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace ShowMe.Core.Speech;

/// <summary>
/// Turns caption Markdown into text that sounds natural when spoken, and splits it into
/// sentence-sized chunks so speech can start before the whole step is synthesized.
/// Port of src/tts/normalize.ts; the patterns spell out JavaScript's \s, \w and \b.
/// </summary>
public static class SpeechText
{
    private const string S = Js.S;
    private const string W = Js.W;
    private const string B = Js.B;

    private static readonly Regex CodeFence = new("```[\\s\\S]*?```");
    private static readonly Regex Link = new(@"\[([^\]]+)\]\([^)]*\)");
    private static readonly Regex InlineCode = new("`([^`]+)`");
    private static readonly Regex Emphasis = new(@"\*\*|__|(?<!" + W + @")\*(?!" + S + ")|(?<!" + S + @")\*(?!" + W + ")");
    private static readonly Regex LineMarker = new("^" + S + "*(#{1,6}|[-*+]|[0-9]+\\.)" + S + "+", RegexOptions.Multiline);
    private static readonly Regex SnakeWord = new(B + "[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+" + B);
    private static readonly Regex CamelWord = new(B + "[a-z]+[A-Z][A-Za-z0-9]*" + B);
    private static readonly Regex PascalWord = new(B + "[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*" + B);
    private static readonly Regex Arrow = new(S + "*=>" + S + "*");
    private static readonly Regex Ampersand = new(S + "&" + S);
    private static readonly Regex Symbols = new(@"[{}\[\]<>|#~^]");
    private static readonly Regex Spaces = new(S + "+");

    public static string ToSpeech(string markdown)
    {
        var s = markdown;
        // Fenced code blocks are not meant to be read aloud.
        s = CodeFence.Replace(s, " ");
        // Links: keep the label.
        s = Link.Replace(s, "$1");
        // Inline code: speak the identifier.
        s = InlineCode.Replace(s, m => SpeakCode(m.Groups[1].Value));
        // Emphasis markers.
        s = Emphasis.Replace(s, "");
        // Headings and bullets at line start.
        s = LineMarker.Replace(s, "");
        // Bare identifiers that appear outside backticks.
        s = SnakeWord.Replace(s, m => SplitIdentifier(m.Value));
        s = CamelWord.Replace(s, m => SplitIdentifier(m.Value));
        s = PascalWord.Replace(s, m => SplitIdentifier(m.Value));
        // Common symbols.
        s = Arrow.Replace(s, " arrow ");
        s = Ampersand.Replace(s, " and ");
        s = Symbols.Replace(s, " ");
        return Js.Trim(Spaces.Replace(s, " "));
    }

    private static readonly Regex PathSeparator = new(@"[\\/]");
    private static readonly Regex AnySpace = new(S);
    private static readonly Regex CallParens = new(@"\([^()]*\)");
    private static readonly Regex OptionalChain = new(@"\?\.");
    private static readonly Regex ScopeOperator = new("::|->");
    private static readonly Regex Unspeakable = new("[^A-Za-z0-9_" + Js.SpaceChars + "'-]");

    /// <summary>How a colleague would say a code token out loud.</summary>
    public static string SpeakCode(string code)
    {
        var c = Js.Trim(code);
        // File paths: just the file name ("login dot ts").
        if (PathSeparator.IsMatch(c) && !AnySpace.IsMatch(c))
        {
            var parts = PathSeparator.Split(c).Where(p => p.Length > 0).ToList();
            if (parts.Count > 0) c = parts[parts.Count - 1];
        }
        // Drop call parentheses and their arguments: foo(bar) -> foo
        c = CallParens.Replace(c, "");
        // Member access and scope operators.
        c = ScopeOperator.Replace(OptionalChain.Replace(c, "."), ".");
        c = string.Join(" dot ", c.Split('.').Where(p => p.Length > 0).Select(SplitIdentifier));
        return Js.Trim(Spaces.Replace(Unspeakable.Replace(c, " "), " "));
    }

    private static readonly Regex EdgeMarks = new(@"\A[_$]+|[_$]+\z");
    private static readonly Regex Separators = new("[_-]+");
    private static readonly Regex LowerUpper = new("([a-z0-9])([A-Z])");
    private static readonly Regex AcronymWord = new("([A-Z]+)([A-Z][a-z])");

    /// <summary>findUserById → "find User By Id", parseHTTPRequest → "parse HTTP Request", MAX_RETRIES → "MAX RETRIES".</summary>
    public static string SplitIdentifier(string word)
    {
        var w = EdgeMarks.Replace(word, "");
        w = Separators.Replace(w, " ");
        w = LowerUpper.Replace(w, "$1 $2");
        w = AcronymWord.Replace(w, "$1 $2");
        return Js.Trim(w);
    }

    private static readonly string[] Abbreviations = { "e.g.", "i.e.", "etc.", "vs.", "Mr.", "Mrs.", "Dr.", "approx." };
    private const int MinChunk = 40;
    private const int MaxChunk = 280;
    private static readonly Regex SentenceBreak = new("(?<=[.!?])" + S + "+(?=[\"'(]?[A-Z0-9])|\n{2,}");
    private static readonly Regex Placeholder = new("\u0000([0-9]+)\u0000");

    /// <summary>Splits speech text into chunks of roughly one sentence, merging very short ones.</summary>
    public static List<string> SplitSentences(string text)
    {
        var protectedText = text;
        for (int i = 0; i < Abbreviations.Length; i++)
            protectedText = protectedText.Replace(Abbreviations[i], $"\u0000{i}\u0000");

        var raw = SentenceBreak.Split(protectedText)
            .Select(s => Js.Trim(Placeholder.Replace(s, m => Abbreviations[int.Parse(m.Groups[1].Value)])))
            .Where(s => s.Length > 0);

        var chunks = new List<string>();
        foreach (var sentence in raw.SelectMany(SplitLong))
        {
            if (chunks.Count > 0)
            {
                var last = chunks[chunks.Count - 1];
                if (last.Length < MinChunk && last.Length + sentence.Length + 1 <= MaxChunk)
                {
                    chunks[chunks.Count - 1] = $"{last} {sentence}";
                    continue;
                }
            }
            chunks.Add(sentence);
        }
        return chunks;
    }

    private static IEnumerable<string> SplitLong(string sentence)
    {
        if (sentence.Length <= MaxChunk) return new[] { sentence };
        var parts = new List<string>();
        var rest = sentence;
        while (rest.Length > MaxChunk)
        {
            var window = rest.Substring(0, MaxChunk);
            int cut = Math.Max(window.LastIndexOf("; ", StringComparison.Ordinal),
                Math.Max(window.LastIndexOf(", ", StringComparison.Ordinal), window.LastIndexOf(" — ", StringComparison.Ordinal)));
            int at = cut > MinChunk ? cut + 1 : window.LastIndexOf(' ');
            if (at <= 0) break;
            parts.Add(Js.Trim(rest.Substring(0, at)));
            rest = Js.Trim(rest.Substring(at));
        }
        if (rest.Length > 0) parts.Add(rest);
        return parts;
    }

    /// <summary>Rough reading time for captions-only mode.</summary>
    public static int ReadingTimeMs(string text, int wordsPerMinute = 170)
    {
        int words = Spaces.Split(text).Count(w => w.Length > 0);
        return (int)Math.Max(1500, Js.Round(words / (double)wordsPerMinute * 60_000));
    }
}
