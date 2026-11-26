using System;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ShowMe.Core;

/// <summary>
/// JavaScript semantics that the TypeScript original relies on: what counts as whitespace in
/// <c>\s</c> and <c>trim()</c>, ASCII-only <c>\w</c> and <c>\b</c>, <c>Math.round</c>,
/// <c>Number(x)</c> and <c>JSON.stringify</c>. .NET differs on each of these, so the port uses
/// these helpers instead of the .NET defaults.
/// </summary>
internal static class Js
{
    /// <summary>Contents of a regex character class matching JavaScript's <c>\s</c>.</summary>
    public const string SpaceChars = @"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

    /// <summary>JavaScript <c>\s</c>.</summary>
    public const string S = "[" + SpaceChars + "]";

    /// <summary>JavaScript <c>\w</c> (ASCII only, unlike .NET's).</summary>
    public const string W = "[A-Za-z0-9_]";

    /// <summary>JavaScript <c>\b</c>: a boundary between ASCII word and non-word characters.</summary>
    public const string B = "(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";

    public static bool IsSpace(char c) =>
        c is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680' or '\u2028' or '\u2029'
            or '\u202f' or '\u205f' or '\u3000' or '\ufeff'
        || (c >= '\u2000' && c <= '\u200a');

    /// <summary><c>String.prototype.trim</c>.</summary>
    public static string Trim(string s)
    {
        int start = 0, end = s.Length;
        while (start < end && IsSpace(s[start])) start++;
        while (end > start && IsSpace(s[end - 1])) end--;
        return s.Substring(start, end - start);
    }

    /// <summary><c>Math.round</c>: halves round up, toward positive infinity.</summary>
    public static double Round(double x) => Math.Floor(x + 0.5);

    public static bool IsInteger(double d) => !double.IsNaN(d) && !double.IsInfinity(d) && Math.Floor(d) == d;

    /// <summary><c>Number(value)</c> for a JSON value.</summary>
    public static double ToNumber(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Number => e.GetDouble(),
        JsonValueKind.String => StringToNumber(e.GetString() ?? ""),
        JsonValueKind.True => 1,
        JsonValueKind.False => 0,
        JsonValueKind.Null => 0,
        JsonValueKind.Array => e.GetArrayLength() switch
        {
            0 => 0,
            1 => e[0].ValueKind is JsonValueKind.Number or JsonValueKind.String ? ToNumber(e[0]) : double.NaN,
            _ => double.NaN,
        },
        _ => double.NaN,
    };

    /// <summary><c>Number(string)</c>: decimal, exponent, hex and Infinity; anything else is NaN.</summary>
    public static double StringToNumber(string s)
    {
        var t = Trim(s);
        if (t.Length == 0) return 0;
        if (t is "Infinity" or "+Infinity") return double.PositiveInfinity;
        if (t == "-Infinity") return double.NegativeInfinity;
        if (t.Length > 2 && t[0] == '0' && (t[1] is 'x' or 'X'))
        {
            double v = 0;
            for (int i = 2; i < t.Length; i++)
            {
                int digit = HexDigit(t[i]);
                if (digit < 0) return double.NaN;
                v = v * 16 + digit;
            }
            return v;
        }
        foreach (char c in t)
        {
            if (c is not ((>= '0' and <= '9') or '.' or 'e' or 'E' or '+' or '-')) return double.NaN;
        }
        return double.TryParse(t, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowExponent,
            CultureInfo.InvariantCulture, out var d) ? d : double.NaN;
    }

    private static int HexDigit(char c) =>
        c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;

    /// <summary><c>JSON.stringify(string)</c>.</summary>
    public static string Quote(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    bool loneSurrogate =
                        (char.IsHighSurrogate(c) && (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])))
                        || (char.IsLowSurrogate(c) && (i == 0 || !char.IsHighSurrogate(s[i - 1])));
                    if (c < ' ' || loneSurrogate) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    /// <summary><c>JSON.stringify(value)</c> for a JSON value (compact, keys in document order).</summary>
    public static string Stringify(JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var sb = new StringBuilder("{");
                bool first = true;
                foreach (var p in e.EnumerateObject())
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append(Quote(p.Name)).Append(':').Append(Stringify(p.Value));
                }
                return sb.Append('}').ToString();
            }
            case JsonValueKind.Array:
            {
                var sb = new StringBuilder("[");
                bool first = true;
                foreach (var item in e.EnumerateArray())
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append(Stringify(item));
                }
                return sb.Append(']').ToString();
            }
            case JsonValueKind.String: return Quote(e.GetString() ?? "");
            case JsonValueKind.Number: return NumberToString(e.GetDouble());
            case JsonValueKind.True: return "true";
            case JsonValueKind.False: return "false";
            default: return "null";
        }
    }

    /// <summary><c>Number.prototype.toString</c> for the values a tour can contain.</summary>
    public static string NumberToString(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) return "null"; // what JSON.stringify writes
        if (d == 0) return "0";
        if (IsInteger(d) && Math.Abs(d) < 1e21) return d.ToString("0", CultureInfo.InvariantCulture);
        var r = d.ToString("R", CultureInfo.InvariantCulture);
        int e = r.IndexOf('E');
        if (e < 0) return r;
        var exp = int.Parse(r.Substring(e + 1), CultureInfo.InvariantCulture);
        return r.Substring(0, e) + "e" + (exp >= 0 ? "+" : "-") + Math.Abs(exp).ToString(CultureInfo.InvariantCulture);
    }
}
