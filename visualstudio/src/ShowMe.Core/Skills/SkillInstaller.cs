using System;
using System.IO;

namespace ShowMe.Core.Skills;

public sealed class SkillTarget
{
    public SkillTarget(string name, string personal, string project)
    {
        Name = name;
        Personal = personal;
        Project = project;
    }

    public string Name { get; }
    public string Personal { get; }
    public string Project { get; }
    public override string ToString() => Name;
}

public static class SkillInstaller
{
    public static readonly SkillTarget[] Targets =
    {
        new SkillTarget("GitHub Copilot", ".copilot/skills", ".github/skills"),
        new SkillTarget("Claude Code", ".claude/skills", ".claude/skills"),
        new SkillTarget("OpenAI Codex", ".agents/skills", ".agents/skills"),
        new SkillTarget("OpenCode", ".config/opencode/skills", ".opencode/skills"),
        new SkillTarget("Cursor", ".cursor/skills", ".cursor/skills"),
        new SkillTarget("Gemini CLI", ".gemini/skills", ".gemini/skills"),
        new SkillTarget("Shared agents directory (Copilot, Codex, OpenCode, Cursor, Gemini)", ".agents/skills", ".agents/skills"),
    };

    public static string Destination(string root, SkillTarget target, bool project) =>
        Path.Combine(root, (project ? target.Project : target.Personal).Replace('/', Path.DirectorySeparatorChar), "show-me");

    public static void Install(string source, string destination)
    {
        if (!File.Exists(Path.Combine(source, "SKILL.md")))
            throw new FileNotFoundException("The bundled SKILL.md is missing.", Path.Combine(source, "SKILL.md"));

        if (Directory.Exists(destination) || File.Exists(destination))
        {
            var attributes = File.GetAttributes(destination);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("The existing skill is a link. Remove it manually before installing.");
            if ((attributes & FileAttributes.Directory) != 0) Directory.Delete(destination, recursive: true);
            else File.Delete(destination);
        }
        CopyDirectory(source, destination);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        foreach (var dir in Directory.GetDirectories(source)) CopyDirectory(dir, Path.Combine(destination, Path.GetFileName(dir)));
    }
}
