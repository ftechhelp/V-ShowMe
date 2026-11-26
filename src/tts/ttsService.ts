/**
 * Chooses a speech engine per tour, turns narration into cached audio clips, and implements the
 * player's Narrator interface (clips + prefetch).
 *
 * Engines: Kokoro (local neural, default) → the OS's own voice (fallback) → none (captions only).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Narrator } from '../player/player';
import { KokoroDtype, KokoroEngine } from './kokoro';
import { audioOutputAvailable, audioOutputHint } from './audioPlayer';
import { SystemVoice, systemVoice } from './systemVoice';
import { readingTimeMs, splitSentences, toSpeech } from './normalize';
import { SpeechQueue } from './speechQueue';

export type EngineId = 'kokoro' | 'system' | 'none';

interface ClipParams {
  engine: Exclude<EngineId, 'none'>;
  voice: string;
  speed: number;
  dtype: KokoroDtype;
  text: string;
}

const AUDIO_CACHE_MAX_AGE_MS = 14 * 24 * 3600_000;

export class TtsService implements Narrator, vscode.Disposable {
  private readonly kokoro: KokoroEngine;
  private readonly queue = new SpeechQueue((key) => this.synthesize(key));
  private readonly params = new Map<string, ClipParams>();
  private readonly audioDir: string;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private engine: EngineId = 'none';
  private narrations: string[] = [];
  private sentences: string[][] = [];
  private download: Thenable<void> | undefined;
  private downloadPct: number | undefined;
  private warnedFallback = false;
  private warnedNoAudio = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: (line: string) => void,
    private readonly showOutput: () => void,
  ) {
    const storage = context.globalStorageUri.fsPath;
    this.audioDir = path.join(storage, 'audio');
    fs.mkdirSync(this.audioDir, { recursive: true });
    pruneOldFiles(this.audioDir, AUDIO_CACHE_MAX_AGE_MS);

    this.kokoro = new KokoroEngine(
      context.asAbsolutePath(path.join('dist', 'kokoroWorker.js')),
      path.join(storage, 'models'),
      log,
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('showme.tts')) {
          this.queue.reset();
          this.changeEmitter.fire();
        }
      }),
    );
  }

  /** Human-readable engine status for the sidebar. */
  get label(): string {
    const voice = cfg<string>('tts.kokoroVoice');
    const downloading = this.downloadPct !== undefined ? ` · Kokoro downloading ${this.downloadPct}%` : '';
    switch (this.engine) {
      case 'kokoro':
        return `Kokoro · ${voice}`;
      case 'system': {
        const v = systemVoiceSetting();
        return `${systemVoice()?.label ?? 'System voice'}${v ? ` · ${v}` : ''}${downloading}`;
      }
      default:
        return `Captions only${downloading}`;
    }
  }

  /** Picks the engine and pre-computes the speech chunks for a tour. May take a moment (model load). */
  async prepareTour(narrations: string[]): Promise<void> {
    this.narrations = narrations;
    this.sentences = narrations.map((n) => splitSentences(toSpeech(n)));
    this.queue.clear();
    this.engine = await this.chooseEngine();
    this.log(`[tts] engine for this tour: ${this.engine}`);
    this.changeEmitter.fire();
  }

  clips(index: number): Promise<string>[] {
    if (this.engine === 'none') return [];
    return (this.sentences[index] ?? []).map((text) => this.queue.request(this.keyFor(text), text));
  }

  prefetch(indices: number[]): void {
    if (this.engine === 'none') return;
    const keys: string[] = [];
    for (const i of indices) {
      for (const text of this.sentences[i] ?? []) {
        const key = this.keyFor(text);
        keys.push(key);
        this.queue.request(key, text);
      }
    }
    this.queue.prioritize(keys);
  }

  silentDurationMs(index: number): number {
    return readingTimeMs(this.narrations[index] ?? '');
  }

  /** Synthesizes a one-off sentence with the current settings (for "Test Voice"). */
  async speakOnce(text: string): Promise<string[]> {
    await this.prepareTour([text]);
    return Promise.all(this.clips(0));
  }

  dispose(): void {
    this.queue.clear();
    this.kokoro.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
  }

  private async chooseEngine(): Promise<EngineId> {
    const wanted = engineSetting();
    if (wanted === 'none') return 'none';
    if (!audioOutputAvailable()) {
      if (!this.warnedNoAudio) {
        this.warnedNoAudio = true;
        this.log(`[tts] no audio player found; captions only`);
        void vscode.window.showWarningMessage(`ShowMe: no audio player found, so tours show captions only. ${audioOutputHint()}`);
      }
      return 'none';
    }
    const fallback: EngineId = systemVoice() ? 'system' : 'none';
    if (wanted === 'system') return fallback;

    const dtype = kokoroDtype();
    if (this.kokoro.isReady() || this.kokoro.isModelCached(dtype)) {
      try {
        await this.kokoro.ensureReady(dtype);
        return 'kokoro';
      } catch (err) {
        this.reportKokoroFailure(err);
        return fallback;
      }
    }

    // First run: download the model in the background and narrate with the fallback meanwhile.
    this.startDownload(dtype);
    if (fallback === 'system') {
      if (!this.warnedFallback) {
        this.warnedFallback = true;
        void vscode.window.showInformationMessage(
          `ShowMe: using the built-in ${systemVoice()!.label} while the Kokoro voice model downloads (one time only).`,
        );
      }
      return 'system';
    }
    try {
      await this.download;
      return this.kokoro.isReady() ? 'kokoro' : 'none';
    } catch {
      return 'none';
    }
  }

  private startDownload(dtype: KokoroDtype): void {
    if (this.download) return;
    const size = dtype === 'q8' ? '~90 MB' : '~320 MB';
    this.download = vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `ShowMe: downloading the Kokoro voice model (${size}, one time)` },
      async (progress) => {
        let reported = 0;
        this.downloadPct = 0;
        const sub = this.kokoro.onProgress((loaded, total) => {
          const pct = Math.floor((loaded / total) * 100);
          if (pct > reported) {
            progress.report({ increment: pct - reported, message: `${pct}%` });
            reported = pct;
            this.downloadPct = pct;
            this.changeEmitter.fire();
          }
        });
        try {
          await this.kokoro.ensureReady(dtype);
          void vscode.window.showInformationMessage('ShowMe: the Kokoro voice is ready and will be used from the next tour on.');
        } catch (err) {
          this.reportKokoroFailure(err);
        } finally {
          sub.dispose();
          this.download = undefined;
          this.downloadPct = undefined;
          this.changeEmitter.fire();
        }
      },
    );
  }

  private reportKokoroFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`[tts] Kokoro unavailable: ${message}`);
    void vscode.window
      .showWarningMessage(
        `ShowMe: the Kokoro voice could not start${systemVoice() ? `, using the ${systemVoice()!.label} instead` : ''}. See the ShowMe output for details.`,
        'Show Output',
      )
      .then((choice) => {
        if (choice) this.showOutput();
      });
  }

  private keyFor(text: string): string {
    const engine = this.engine as ClipParams['engine'];
    const params: ClipParams = {
      engine,
      voice: engine === 'kokoro' ? cfg<string>('tts.kokoroVoice') : systemVoiceSetting(),
      speed: cfg<number>('tts.speed'),
      dtype: kokoroDtype(),
      text,
    };
    const key = createHash('sha1')
      .update(JSON.stringify([params.engine, params.voice, params.speed, engine === 'kokoro' ? params.dtype : '', text]))
      .digest('hex');
    this.params.set(key, params);
    return key;
  }

  private async synthesize(key: string): Promise<string> {
    const p = this.params.get(key);
    if (!p) throw new Error(`unknown clip ${key}`);

    if (p.engine === 'kokoro') {
      const file = path.join(this.audioDir, `${key}.wav`);
      if (await exists(file)) return file;
      try {
        await this.kokoro.synthesize(p.text, p.voice, p.speed, file, p.dtype);
        return file;
      } catch (err) {
        const sys = systemVoice();
        if (!sys) throw err;
        this.log(`[tts] Kokoro failed for one clip, falling back to the ${sys.label}: ${(err as Error).message}`);
        const fallback = path.join(this.audioDir, `${key}.fallback.${sys.extension}`);
        await sys.speakToFile(p.text, fallback, systemVoiceSetting(), p.speed);
        return fallback;
      }
    }

    const sys: SystemVoice | undefined = systemVoice();
    if (!sys) throw new Error('no system voice on this platform');
    const file = path.join(this.audioDir, `${key}.${sys.extension}`);
    if (await exists(file)) return file;
    await sys.speakToFile(p.text, file, p.voice, p.speed);
    return file;
  }
}

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('showme').get<T>(key) as T;
}

/** `macos` is the pre-0.2 name of `system`. */
function engineSetting(): EngineId {
  const v = cfg<string>('tts.engine');
  if (v === 'macos') return 'system';
  return v === 'system' || v === 'none' ? v : 'kokoro';
}

/** `tts.macosVoice` is the pre-0.2 name of `tts.systemVoice`. */
function systemVoiceSetting(): string {
  return cfg<string>('tts.systemVoice') || cfg<string>('tts.macosVoice') || '';
}

function kokoroDtype(): KokoroDtype {
  return cfg<string>('tts.kokoroModel') === 'q8' ? 'q8' : 'fp32';
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

function pruneOldFiles(dir: string, maxAgeMs: number): void {
  fs.promises
    .readdir(dir)
    .then(async (names) => {
      const cutoff = Date.now() - maxAgeMs;
      for (const name of names) {
        const file = path.join(dir, name);
        const stat = await fs.promises.stat(file).catch(() => undefined);
        if (stat && stat.mtimeMs < cutoff) await fs.promises.unlink(file).catch(() => undefined);
      }
    })
    .catch(() => undefined);
}
