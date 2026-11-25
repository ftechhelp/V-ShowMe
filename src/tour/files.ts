/**
 * Where tours live on disk, how to find them, and the status file that agents read back.
 *
 *   <workspace>/.showme/
 *     .gitignore        "*" so nothing here is ever committed
 *     tours/*.json      written by the agent
 *     status.json       written by the extension (current step, state, issues)
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { Tour } from './schema';

export const SHOWME_DIR = '.showme';
export const TOURS_GLOB = `${SHOWME_DIR}/tours/*.json`;

/** Watches every workspace folder for new or rewritten tours (debounced per file). */
export class TourWatcher implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sub: vscode.Disposable;

  constructor(private readonly onTour: (uri: vscode.Uri) => void) {
    this.sync();
    this.sub = vscode.workspace.onDidChangeWorkspaceFolders(() => this.sync());
  }

  dispose(): void {
    this.sub.dispose();
    this.watchers.forEach((w) => w.dispose());
    this.timers.forEach((t) => clearTimeout(t));
  }

  private sync(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const keep = new Set(folders.map((f) => f.uri.toString()));
    for (const [key, w] of this.watchers) {
      if (!keep.has(key)) {
        w.dispose();
        this.watchers.delete(key);
      }
    }
    for (const folder of folders) {
      const key = folder.uri.toString();
      if (this.watchers.has(key)) continue;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, TOURS_GLOB));
      w.onDidCreate((uri) => this.fire(uri));
      w.onDidChange((uri) => this.fire(uri));
      this.watchers.set(key, w);
    }
  }

  private fire(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.onTour(uri);
      }, 350),
    );
  }
}

export interface TourEntry {
  uri: vscode.Uri;
  title: string;
  mtime: number;
}

/** All tours in all workspace folders, newest first. */
export async function listTours(): Promise<TourEntry[]> {
  const entries: TourEntry[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const dir = vscode.Uri.joinPath(folder.uri, SHOWME_DIR, 'tours');
    let names: [string, vscode.FileType][];
    try {
      names = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }
    for (const [name, type] of names) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
      const uri = vscode.Uri.joinPath(dir, name);
      try {
        const [stat, bytes] = await Promise.all([vscode.workspace.fs.stat(uri), vscode.workspace.fs.readFile(uri)]);
        let title = name;
        try {
          const json = JSON.parse(new TextDecoder().decode(bytes));
          if (typeof json?.title === 'string') title = json.title;
        } catch {
          // keep file name
        }
        entries.push({ uri, title, mtime: stat.mtime });
      } catch {
        // unreadable, skip
      }
    }
  }
  return entries.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Directory step paths resolve against:
 *  1. `root` in the tour, relative to the tour file
 *  2. the folder that contains `.showme/tours/<tour>.json`
 *  3. the workspace folder containing the tour file
 *  4. the tour file's own directory
 */
export function resolveTourRoot(tourUri: vscode.Uri, tour: Tour): vscode.Uri {
  const dir = path.dirname(tourUri.fsPath);
  if (tour.root) return vscode.Uri.file(path.resolve(dir, tour.root));
  const inShowme = showmeDirOf(tourUri);
  if (inShowme) return vscode.Uri.file(path.dirname(inShowme.fsPath));
  const folder = vscode.workspace.getWorkspaceFolder(tourUri);
  return folder?.uri ?? vscode.Uri.file(dir);
}

/** The `.showme` directory where status for this tour is written, if there is a sensible one. */
export function statusDirFor(tourUri: vscode.Uri): vscode.Uri | undefined {
  const inShowme = showmeDirOf(tourUri);
  if (inShowme) return inShowme;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, SHOWME_DIR) : undefined;
}

function showmeDirOf(tourUri: vscode.Uri): vscode.Uri | undefined {
  const toursDir = path.dirname(tourUri.fsPath);
  const showmeDir = path.dirname(toursDir);
  if (path.basename(toursDir) === 'tours' && path.basename(showmeDir) === SHOWME_DIR) {
    return vscode.Uri.file(showmeDir);
  }
  return undefined;
}

/** Creates `.showme/` with a self-ignoring .gitignore. */
export async function ensureShowmeDir(dir: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(dir);
  const ignore = vscode.Uri.joinPath(dir, '.gitignore');
  try {
    await vscode.workspace.fs.stat(ignore);
  } catch {
    await vscode.workspace.fs.writeFile(ignore, new TextEncoder().encode('# Created by the ShowMe extension\n*\n'));
  }
}

/** Debounced writer for `.showme/status.json`. */
export class StatusWriter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: { dir: vscode.Uri; data: unknown } | undefined;

  constructor(private readonly log: (line: string) => void) {}

  write(dir: vscode.Uri, data: unknown): void {
    this.pending = { dir, data };
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const p = this.pending;
      this.pending = undefined;
      if (p) void this.flush(p.dir, p.data);
    }, 120);
  }

  private async flush(dir: vscode.Uri, data: unknown): Promise<void> {
    try {
      await ensureShowmeDir(dir);
      const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'status.json'), bytes);
    } catch (err) {
      this.log(`[status] could not write status.json: ${(err as Error).message}`);
    }
  }
}
