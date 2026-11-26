import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { existingSkill, installSkillFiles, skillTargets } from '../src/skill';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'showme-skill-'));
  temporary.push(root);
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'reference'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), 'skill');
  await fs.writeFile(path.join(source, 'reference', 'tour-format.md'), 'reference');
  return { root, source, target: path.join(root, 'project', '.github', 'skills', 'show-me') };
}

describe('skill installation', () => {
  it('uses the documented personal and project directories', () => {
    expect(skillTargets.map(({ label, personal, project }) => [label, personal, project])).toEqual([
      ['GitHub Copilot', '.copilot/skills', '.github/skills'],
      ['Claude Code', '.claude/skills', '.claude/skills'],
      ['OpenAI Codex', '.agents/skills', '.agents/skills'],
      ['OpenCode', '.config/opencode/skills', '.opencode/skills'],
      ['Cursor', '.cursor/skills', '.cursor/skills'],
      ['Gemini CLI', '.gemini/skills', '.gemini/skills'],
      ['Shared agents directory', '.agents/skills', '.agents/skills'],
    ]);
  });

  it('copies the complete skill and replaces an existing installation', async () => {
    const { source, target } = await fixture();
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'old'), 'old');
    await installSkillFiles(source, target, false);
    expect(await fs.readFile(path.join(target, 'reference', 'tour-format.md'), 'utf8')).toBe('reference');
    expect(await existingSkill(path.join(target, 'old'))).toBeUndefined();
  });

  it('does not remove an existing installation when the bundled skill is missing', async () => {
    const { root, target } = await fixture();
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), 'original');
    await expect(installSkillFiles(path.join(root, 'missing'), target, false)).rejects.toThrow();
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('original');
  });

  it('replaces a link without deleting its original contents', async () => {
    const { root, source, target } = await fixture();
    const old = path.join(root, 'old');
    await fs.mkdir(old);
    await fs.writeFile(path.join(old, 'keep'), 'safe');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(old, target, process.platform === 'win32' ? 'junction' : 'dir');
    await installSkillFiles(source, target, false);
    expect(await fs.readFile(path.join(old, 'keep'), 'utf8')).toBe('safe');
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('skill');
  });
});
