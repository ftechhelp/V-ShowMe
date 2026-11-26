using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace ShowMe.Core.Tours;

/// <summary>
/// Re-locates a step's line range when the file changed since the agent read it. Port of
/// src/tour/anchor.ts.
///
/// The agent records the text of the first highlighted line as the anchor. If that text is no
/// longer on the start line, we look for the occurrence nearest to the original position and
/// shift the whole range by the same amount.
/// </summary>
public static class AnchorResolver
{
    private static readonly Regex Whitespace = new(Js.S + "+");
    private static readonly Regex LineBreak = new("\r?\n");

    public static ResolvedRange Resolve(IReadOnlyList<string> docLines, int start, int end, string? anchor)
    {
        int lineCount = Math.Max(docLines.Count, 1);
        string? warning = null;

        string needle = "";
        if (!string.IsNullOrEmpty(anchor))
        {
            foreach (var line in LineBreak.Split(anchor))
            {
                if (Js.Trim(line).Length > 0)
                {
                    needle = Normalize(line);
                    break;
                }
            }
        }

        if (needle.Length > 0)
        {
            int startIdx = start - 1;
            bool onStartLine = startIdx >= 0 && startIdx < docLines.Count && Contains(Normalize(docLines[startIdx]), needle);
            if (!onStartLine)
            {
                int? found = NearestMatch(docLines, needle, startIdx);
                if (found is { } f)
                {
                    int delta = f - startIdx;
                    start += delta;
                    end += delta;
                }
                else
                {
                    warning = $"Anchor {Js.Quote(anchor!)} not found in file; using lines {start}-{end} as given.";
                }
            }
        }

        if (start > lineCount)
        {
            var msg = $"Lines {start}-{end} are past the end of the file ({lineCount} lines).";
            warning = warning != null ? $"{warning} {msg}" : msg;
            int span = end - start;
            start = Math.Max(1, lineCount - span);
            end = lineCount;
        }
        end = Math.Min(Math.Max(end, start), lineCount);

        return new ResolvedRange(start, end, warning);
    }

    private static int? NearestMatch(IReadOnlyList<string> lines, string needle, int around)
    {
        int? best = null;
        int bestDist = int.MaxValue;
        for (int i = 0; i < lines.Count; i++)
        {
            if (Contains(Normalize(lines[i]), needle))
            {
                int dist = Math.Abs(i - around);
                if (dist < bestDist)
                {
                    best = i;
                    bestDist = dist;
                }
            }
        }
        return best;
    }

    private static string Normalize(string s) => Js.Trim(Whitespace.Replace(s, " "));

    private static bool Contains(string haystack, string needle) => haystack.IndexOf(needle, StringComparison.Ordinal) >= 0;
}

public sealed class ResolvedRange
{
    public ResolvedRange(int start, int end, string? warning)
    {
        Start = start;
        End = end;
        Warning = warning;
    }

    /// <summary>1-based inclusive.</summary>
    public int Start { get; }
    public int End { get; }
    public string? Warning { get; }
}
