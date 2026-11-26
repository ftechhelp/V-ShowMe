/** Finds executables on PATH without spawning a shell, so callers can run the real binary directly. */
import * as fs from 'fs';
import * as path from 'path';

export interface WhichEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable: (file: string) => boolean;
}

const defaultEnv: WhichEnv = {
  platform: process.platform,
  env: process.env,
  isExecutable: (file) => {
    try {
      fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
};

/** Full path of `cmd` if it is on PATH (with PATHEXT on Windows), else undefined. */
export function findOnPath(cmd: string, w: WhichEnv = defaultEnv): string | undefined {
  const p = w.platform === 'win32' ? path.win32 : path.posix;
  const pathVar = w.env.PATH ?? w.env.Path ?? '';
  const dirs = pathVar.split(w.platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = w.platform === 'win32' ? (w.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasExt = w.platform === 'win32' && /\.[^\\/.]+$/.test(cmd);
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const file = p.join(dir, cmd + ext);
      if (w.isExecutable(file)) return file;
    }
  }
  return undefined;
}

/** The first of `cmds` found on PATH. */
export function findFirstOnPath(cmds: string[], w: WhichEnv = defaultEnv): { cmd: string; file: string } | undefined {
  for (const cmd of cmds) {
    const file = findOnPath(cmd, w);
    if (file) return { cmd, file };
  }
  return undefined;
}
