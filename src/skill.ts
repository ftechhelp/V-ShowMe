import * as fs from 'fs';
import * as path from 'path';

export const skillTargets = [
  { label: 'GitHub Copilot', personal: '.copilot/skills', project: '.github/skills' },
  { label: 'Claude Code', personal: '.claude/skills', project: '.claude/skills' },
  { label: 'OpenAI Codex', personal: '.agents/skills', project: '.agents/skills' },
  { label: 'OpenCode', personal: '.config/opencode/skills', project: '.opencode/skills' },
  { label: 'Cursor', personal: '.cursor/skills', project: '.cursor/skills' },
  { label: 'Gemini CLI', personal: '.gemini/skills', project: '.gemini/skills' },
  { label: 'Shared agents directory', personal: '.agents/skills', project: '.agents/skills' },
] as const;

export async function existingSkill(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function installSkillFiles(source: string, target: string, link: boolean): Promise<void> {
  // Verify the source before removing an existing installation.
  await fs.promises.access(path.join(source, 'SKILL.md'));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  if (await existingSkill(target)) await fs.promises.rm(target, { recursive: true, force: true });
  if (link) {
    await fs.promises.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    await fs.promises.cp(source, target, { recursive: true });
  }
}
