import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { listTours } from './tour/files';
import { existingSkill, installSkillFiles, skillTargets } from './skill';

export async function installSkill(context: vscode.ExtensionContext): Promise<void> {
  const harness = await vscode.window.showQuickPick(skillTargets.map((item) => ({
    label: item.label,
    description: item.label === 'Shared agents directory' ? 'Copilot, Codex, OpenCode, Cursor and Gemini CLI' : undefined,
    target: item,
  })), { title: 'ShowMe: choose an agent', placeHolder: 'Choose where the skill will be discovered' });
  if (!harness) return;
  const scope = await vscode.window.showQuickPick([
    { label: 'Personal', description: 'Available across projects on this machine', project: false },
    { label: 'Project', description: 'Copy into an open workspace folder', project: true },
  ], { title: 'ShowMe: choose skill scope' });
  if (!scope) return;
  let root = os.homedir();
  if (scope.project) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      void vscode.window.showErrorMessage('ShowMe: open a workspace folder to install a project skill.');
      return;
    }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Choose the project folder for the skill',
    });
    if (!folder) return;
    if (folder.uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('ShowMe: installing a skill requires a local workspace folder.');
      return;
    }
    root = folder.uri.fsPath;
  }

  const source = context.asAbsolutePath(path.join('skill', 'show-me'));
  const target = path.join(root, scope.project ? harness.target.project : harness.target.personal, 'show-me');
  const link = !scope.project && context.extensionMode === vscode.ExtensionMode.Development;
  try {
    const existing = await existingSkill(target);
    if (existing) {
      if (link && existing.isSymbolicLink() && samePath(path.resolve(path.dirname(target), await fs.promises.readlink(target)), source)) {
        void vscode.window.showInformationMessage('ShowMe: the skill is already linked to this checkout. Nothing to do.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `A "show-me" skill already exists at ${tildify(target)}. Replace it with the version bundled in this extension?`,
        { modal: true },
        'Replace',
      );
      if (choice !== 'Replace') return;
    }
    await installSkillFiles(source, target, link);
    void vscode.window.showInformationMessage(
      `ShowMe: skill ${link ? 'linked' : 'installed'} at ${tildify(target)}. Ask your agent: "show me how … works".`,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`ShowMe: could not install the skill: ${(error as Error).message}`);
  }
}

/** Quick pick of saved tours, newest first, plus a file browser fallback. */
export async function pickTour(): Promise<vscode.Uri | undefined> {
  const tours = await listTours();
  type Item = vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean };
  const items: Item[] = tours.map((t) => ({
    label: t.title,
    description: vscode.workspace.asRelativePath(t.uri),
    detail: timeAgo(t.mtime),
    uri: t.uri,
  }));
  items.push({ label: '$(folder-opened) Open a tour file…', browse: true, alwaysShow: true });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'ShowMe: play a tour',
    placeHolder: tours.length ? 'Pick a tour to play' : 'No tours in .showme/tours yet. Ask your agent to "show me" something.',
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  if (picked.uri) return picked.uri;

  const files = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'ShowMe tour': ['json'] },
    openLabel: 'Play tour',
  });
  return files?.[0];
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}
