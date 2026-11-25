using System;
using System.IO;
using ShowMe.Core.Tours;

namespace ShowMe.Core.Status;

/// <summary>
/// Where tours live on disk and the status file that agents read back. Port of src/tour/files.ts.
///
///   &lt;workspace&gt;/.showme/
///     .gitignore        "*" so nothing here is ever committed
///     tours/*.json      written by the agent
///     status.json       written by the extension (current step, state, issues)
/// </summary>
public static class TourPaths
{
    public const string ShowmeDirName = ".showme";
    public const string GitIgnoreContent = "# Created by the ShowMe extension\n*\n";

    public static string ToursDir(string workspaceRoot) => Path.Combine(workspaceRoot, ShowmeDirName, "tours");

    /// <summary>The <c>.showme</c> folder a tour lives in (…/.showme/tours/x.json), or null.</summary>
    public static string? ShowmeDirOf(string tourPath)
    {
        var toursDir = Path.GetDirectoryName(Path.GetFullPath(tourPath));
        var showmeDir = toursDir == null ? null : Path.GetDirectoryName(toursDir);
        if (toursDir != null && showmeDir != null
            && string.Equals(Path.GetFileName(toursDir), "tours", StringComparison.Ordinal)
            && string.Equals(Path.GetFileName(showmeDir), ShowmeDirName, StringComparison.Ordinal))
        {
            return showmeDir;
        }
        return null;
    }

    /// <summary>
    /// Directory that step paths resolve against:
    ///  1. <c>root</c> in the tour, relative to the tour file
    ///  2. the folder that contains <c>.showme/tours/&lt;tour&gt;.json</c>
    ///  3. the workspace root (solution or open folder)
    ///  4. the tour file's own directory
    /// </summary>
    public static string ResolveTourRoot(string tourPath, Tour tour, string? workspaceRoot)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(tourPath)) ?? workspaceRoot ?? ".";
        if (tour.Root != null) return Path.GetFullPath(Path.Combine(dir, ToNative(tour.Root)));
        var showme = ShowmeDirOf(tourPath);
        if (showme != null) return Path.GetDirectoryName(showme)!;
        return workspaceRoot ?? dir;
    }

    /// <summary>The <c>.showme</c> folder where status for this tour is written, if there is a sensible one.</summary>
    public static string? StatusDirFor(string tourPath, string? workspaceRoot) =>
        ShowmeDirOf(tourPath) ?? (workspaceRoot != null ? Path.Combine(workspaceRoot, ShowmeDirName) : null);

    /// <summary>A step's file as an absolute path. Tours use forward slashes.</summary>
    public static string ResolveStepPath(string root, string file) =>
        Path.IsPathRooted(file) ? file : Path.GetFullPath(Path.Combine(root, ToNative(file)));

    /// <summary>Workspace-relative path with forward slashes, for status.json and the UI.</summary>
    public static string Relative(string workspaceRoot, string path)
    {
        var root = Path.GetFullPath(workspaceRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(path);
        var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var rel = full.StartsWith(root, comparison) ? full.Substring(root.Length) : full;
        return rel.Replace('\\', '/');
    }

    private static string ToNative(string p) => p.Replace('/', Path.DirectorySeparatorChar);
}
