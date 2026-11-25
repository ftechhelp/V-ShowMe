using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;

namespace ShowMe.VisualStudio.Workspace;

/// <summary>
/// The folders where an agent may write <c>.showme/</c>. Claude Code usually runs at the
/// repository root, while the solution file often sits in a subfolder, so ShowMe watches the
/// solution (or open) folder and every folder above it up to the repository root.
/// </summary>
internal static class WorkspaceRoots
{
    public static async Task<IReadOnlyList<string>> CurrentAsync()
    {
        var solution = await VS.Solutions.GetCurrentSolutionAsync();
        var path = solution?.FullPath;
        if (string.IsNullOrEmpty(path)) return Array.Empty<string>();
        var start = Directory.Exists(path) ? path! : Path.GetDirectoryName(path);
        return start == null ? Array.Empty<string>() : UpToRepositoryRoot(start);
    }

    /// <summary>The primary root (where status for loose tours goes): the repository root if any.</summary>
    public static string? Primary(IReadOnlyList<string> roots) => roots.Count == 0 ? null : roots[roots.Count - 1];

    internal static IReadOnlyList<string> UpToRepositoryRoot(string start)
    {
        var chain = new List<string>();
        for (var dir = new DirectoryInfo(Path.GetFullPath(start)); dir != null; dir = dir.Parent)
        {
            chain.Add(dir.FullName.TrimEnd(Path.DirectorySeparatorChar));
            if (Directory.Exists(Path.Combine(dir.FullName, ".git")) || File.Exists(Path.Combine(dir.FullName, ".git")))
                return chain;
        }
        // Not in a repository: only the solution folder itself.
        return new[] { chain[0] };
    }
}
