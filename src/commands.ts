import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { listTours } from './tour/files';

/** Copies (or, when developing ShowMe itself, symlinks) the bundled skill into ~/.claude/skills. */
export async function installSkill(context: vscode.ExtensionContext): Promise<void> {
  const source = context.asAbsolutePath(path.join('skill', 'show-me'));
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  const target = path.join(skillsDir, 'show-me');
  const dev = context.extensionMode === vscode.ExtensionMode.Development;

  const existing = await fs.promises.lstat(target).catch(() => undefined);
  if (existing) {
    const isOurLink = existing.isSymbolicLink() && samePath(await fs.promises.readlink(target), source);
    if (isOurLink) {
      void vscode.window.showInformationMessage('ShowMe: the skill is already linked to this checkout. Nothing to do.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `A "show-me" skill already exists at ${tildify(target)}. Replace it with the version bundled in this extension?`,
      { modal: true },
      'Replace',
    );
    if (choice !== 'Replace') return;
    await fs.promises.rm(target, { recursive: true, force: true });
  }

  await fs.promises.mkdir(skillsDir, { recursive: true });
  if (dev) {
    // A junction needs no admin rights or Developer Mode on Windows; other platforms ignore the type.
    await fs.promises.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    await fs.promises.cp(source, target, { recursive: true });
  }

  const how = dev ? 'linked (edits in this repo apply immediately)' : 'installed';
  void vscode.window.showInformationMessage(
    `ShowMe: skill ${how} at ${tildify(target)}. In Claude Code, ask: "show me how … works" (or type /show-me).`,
  );
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
