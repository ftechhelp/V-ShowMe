using ShowMe.Core.Skills;

namespace ShowMe.Core.Tests;

public class SkillInstallerTests
{
    [Theory]
    [InlineData("GitHub Copilot", ".copilot/skills", ".github/skills")]
    [InlineData("Claude Code", ".claude/skills", ".claude/skills")]
    [InlineData("OpenAI Codex", ".agents/skills", ".agents/skills")]
    [InlineData("OpenCode", ".config/opencode/skills", ".opencode/skills")]
    [InlineData("Cursor", ".cursor/skills", ".cursor/skills")]
    [InlineData("Gemini CLI", ".gemini/skills", ".gemini/skills")]
    public void DestinationsUseAgentDirectories(string name, string personal, string project)
    {
        var target = SkillInstaller.Targets.Single(t => t.Name == name);
        Assert.Equal(Path.Combine("root", personal.Replace('/', Path.DirectorySeparatorChar), "show-me"), SkillInstaller.Destination("root", target, false));
        Assert.Equal(Path.Combine("root", project.Replace('/', Path.DirectorySeparatorChar), "show-me"), SkillInstaller.Destination("root", target, true));
    }

    [Fact]
    public void CopiesReferencesAndPreservesExistingSkillIfSourceIsMissing()
    {
        var root = Path.Combine(Path.GetTempPath(), "showme-skill-" + Guid.NewGuid());
        var source = Path.Combine(root, "source");
        var target = Path.Combine(root, "target");
        try
        {
            Directory.CreateDirectory(Path.Combine(source, "reference"));
            File.WriteAllText(Path.Combine(source, "SKILL.md"), "skill");
            File.WriteAllText(Path.Combine(source, "reference", "tour-format.md"), "reference");
            SkillInstaller.Install(source, target);
            Assert.Equal("reference", File.ReadAllText(Path.Combine(target, "reference", "tour-format.md")));
            Assert.Throws<FileNotFoundException>(() => SkillInstaller.Install(Path.Combine(root, "missing"), target));
            Assert.Equal("skill", File.ReadAllText(Path.Combine(target, "SKILL.md")));
            File.WriteAllText(Path.Combine(target, "old"), "old");
            SkillInstaller.Install(source, target);
            Assert.False(File.Exists(Path.Combine(target, "old")));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }
}
