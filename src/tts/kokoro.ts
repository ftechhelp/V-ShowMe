/**
 * Extension-host side of the Kokoro engine: forks kokoroWorker.js, tracks model download
 * progress, and shuts the worker down after a period of inactivity to free memory.
 */
import { ChildProcess, fork } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkerMessage, WorkerRequest } from './kokoroWorker';

export type KokoroDtype = 'fp32' | 'q8';
export type KokoroState = 'stopped' | 'loading' | 'ready' | 'failed';

const IDLE_SHUTDOWN_MS = 10 * 60_000;

export class KokoroEngine {
  state: KokoroState = 'stopped';
  lastError: string | undefined;

  private proc: ChildProcess | undefined;
  private loading: Promise<void> | undefined;
  private loadWaiter: { resolve: () => void; reject: (e: Error) => void } | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly fileProgress = new Map<string, { loaded: number; total: number }>();
  private readonly progressListeners = new Set<(loaded: number, total: number) => void>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private loadedDtype: KokoroDtype | undefined;

  constructor(
    private readonly workerPath: string,
    private readonly cacheDir: string,
    private readonly log: (line: string) => void,
  ) {}

  isReady(): boolean {
    return this.state === 'ready' && !!this.proc;
  }

  isModelCached(dtype: KokoroDtype): boolean {
    const file = dtype === 'q8' ? 'model_quantized.onnx' : 'model.onnx';
    return fs.existsSync(path.join(this.cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', file));
  }

  onProgress(listener: (loaded: number, total: number) => void): { dispose(): void } {
    this.progressListeners.add(listener);
    return { dispose: () => this.progressListeners.delete(listener) };
  }

  ensureReady(dtype: KokoroDtype): Promise<void> {
    if (this.loadedDtype && this.loadedDtype !== dtype) this.dispose();
    if (this.state === 'ready' && this.proc) return Promise.resolve();
    if (this.state === 'loading' && this.loading) return this.loading;

    this.state = 'loading';
    this.lastError = undefined;
    this.fileProgress.clear();
    this.loading = new Promise<void>((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
    });
    // Callers may drop this promise; rejections are surfaced through state/lastError.
    this.loading.catch(() => undefined);

    const proc = fork(this.workerPath, [], {
      execPath: nodeExecPath(),
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.proc = proc;
    proc.stdout?.on('data', (d) => this.log(`[kokoro] ${String(d).trimEnd()}`));
    proc.stderr?.on('data', (d) => this.log(`[kokoro] ${String(d).trimEnd()}`));
    proc.on('message', (msg: WorkerMessage) => this.onMessage(msg, dtype));
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      const err = new Error(this.lastError ?? `Kokoro worker exited (code ${code}, signal ${signal})`);
      if (this.state === 'loading') this.fail(err.message);
      else if (this.state === 'ready') this.state = 'stopped';
      this.rejectAll(err);
    });
    proc.on('error', (err) => this.fail(err.message));

    const init: WorkerRequest = { type: 'init', cacheDir: this.cacheDir, dtype };
    proc.send(init);
    this.log(`[kokoro] starting worker (${dtype}) with ${nodeExecPath()}`);
    return this.loading;
  }

  async synthesize(text: string, voice: string, speed: number, outFile: string, dtype: KokoroDtype): Promise<void> {
    await this.ensureReady(dtype);
    const proc = this.proc;
    if (!proc) throw new Error('Kokoro worker is not running');
    this.clearIdle();
    const id = this.nextId++;
    try {
      await new Promise<void>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const req: WorkerRequest = { type: 'synth', id, text, voice, speed, outFile };
        proc.send(req);
      });
    } finally {
      this.armIdle();
    }
  }

  dispose(): void {
    this.clearIdle();
    const proc = this.proc;
    this.proc = undefined;
    this.loadedDtype = undefined;
    if (this.state === 'loading') this.loadWaiter?.reject(new Error('Kokoro worker stopped'));
    this.state = 'stopped';
    this.rejectAll(new Error('Kokoro worker stopped'));
    proc?.kill();
  }

  private onMessage(msg: WorkerMessage, dtype: KokoroDtype): void {
    switch (msg.type) {
      case 'progress': {
        this.fileProgress.set(msg.file, { loaded: msg.loaded, total: msg.total });
        let loaded = 0;
        let total = 0;
        for (const p of this.fileProgress.values()) {
          loaded += p.loaded;
          total += p.total;
        }
        this.progressListeners.forEach((l) => l(loaded, total));
        break;
      }
      case 'ready':
        this.state = 'ready';
        this.loadedDtype = dtype;
        this.log(`[kokoro] model ready in ${msg.loadMs} ms`);
        this.loadWaiter?.resolve();
        this.armIdle();
        break;
      case 'initFailed':
        this.fail(msg.message);
        this.proc?.kill();
        break;
      case 'done':
        this.pending.get(msg.id)?.resolve();
        this.pending.delete(msg.id);
        break;
      case 'failed':
        this.pending.get(msg.id)?.reject(new Error(msg.message));
        this.pending.delete(msg.id);
        break;
    }
  }

  private fail(message: string): void {
    this.state = 'failed';
    this.lastError = message;
    this.log(`[kokoro] failed: ${message}`);
    this.loadWaiter?.reject(new Error(message));
  }

  private rejectAll(err: Error): void {
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.log('[kokoro] idle, stopping worker');
      this.dispose();
    }, IDLE_SHUTDOWN_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

/**
 * The Node binary used for the worker. VS Code's extension host runs inside the
 * "Code Helper (Plugin)" executable, which is allowed to load third-party native modules
 * (onnxruntime). The main "Code" binary is not (macOS library validation), so if we are
 * somehow running in it, switch to the plugin helper.
 */
function nodeExecPath(): string {
  const exec = process.execPath;
  if (process.platform !== 'darwin' || exec.includes('Helper (Plugin)')) return exec;
  const contents = exec.split('/Contents/')[0] + '/Contents';
  try {
    const frameworks = path.join(contents, 'Frameworks');
    const helperApp = fs.readdirSync(frameworks).find((n) => n.endsWith('Helper (Plugin).app'));
    if (helperApp) {
      const bin = path.join(frameworks, helperApp, 'Contents', 'MacOS', helperApp.replace(/\.app$/, ''));
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    // fall through
  }
  return exec;
}
