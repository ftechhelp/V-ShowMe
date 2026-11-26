/**
 * Plays audio clips through the OS.
 *
 *   macOS    afplay                     pause/resume = SIGSTOP/SIGCONT
 *   Linux    pw-play, paplay or aplay   pause/resume = SIGSTOP/SIGCONT
 *   Windows  one long-lived PowerShell helper driving winmm (see winAudioHost.ts), with real
 *            pause/resume. If it can't start, each clip plays through Media.SoundPlayer instead,
 *            and pause restarts the current sentence.
 */
import { ChildProcess, spawn } from 'child_process';
import type { AudioOut } from '../player/player';
import { findFirstOnPath } from '../util/which';
import { windowsPowerShell } from './systemVoice';
import { WinAudioHost, WinHostEvents, WinHostLike } from './winAudioHost';

export class AudioPlayer implements AudioOut {
  private readonly impl: AudioOut & { dispose(): void };

  constructor(log: (line: string) => void = () => undefined) {
    this.impl =
      process.platform === 'win32'
        ? new WindowsAudio({ createHost: (events) => WinAudioHost.start(events, log), legacyPlay: soundPlayer, log })
        : new SignalAudio();
  }

  play(file: string): Promise<void> {
    return this.impl.play(file);
  }
  pause(): void {
    this.impl.pause();
  }
  resume(): void {
    this.impl.resume();
  }
  stop(): void {
    this.impl.stop();
  }
  dispose(): void {
    this.impl.dispose();
  }
}

/** Whether this machine has a way to play audio at all. */
export function audioOutputAvailable(): boolean {
  return process.platform !== 'linux' || !!linuxPlayer();
}

/** What to install when audioOutputAvailable() is false. */
export function audioOutputHint(): string {
  return 'Install PipeWire (pw-play), pulseaudio-utils (paplay) or alsa-utils (aplay).';
}

// --- macOS and Linux: one player process per clip, paused with signals -------------------------

class SignalAudio implements AudioOut {
  private proc: ChildProcess | undefined;
  private current: { done: () => void } | undefined;
  private paused = false;

  play(file: string): Promise<void> {
    this.kill();
    const command = playerCommand(file);
    if (!command) return Promise.resolve();
    return new Promise<void>((done) => {
      this.current = { done };
      const p = spawn(command[0], command[1], { stdio: 'ignore' });
      this.proc = p;
      if (this.paused) p.kill('SIGSTOP');
      const finish = () => {
        if (this.proc !== p) return;
        this.proc = undefined;
        const c = this.current;
        this.current = undefined;
        c?.done();
      };
      p.on('exit', finish);
      p.on('error', (err) => {
        console.error('[ShowMe] audio player failed:', err);
        finish();
      });
    });
  }

  pause(): void {
    this.paused = true;
    this.proc?.kill('SIGSTOP');
  }

  resume(): void {
    this.paused = false;
    this.proc?.kill('SIGCONT');
  }

  stop(): void {
    this.kill();
    this.paused = false;
  }

  dispose(): void {
    this.stop();
  }

  /** Ends the current clip (resolving its play() promise) without touching the paused flag. */
  private kill(): void {
    const p = this.proc;
    const c = this.current;
    this.proc = undefined;
    this.current = undefined;
    if (p) {
      p.removeAllListeners('exit');
      p.kill('SIGCONT'); // a stopped process would ignore SIGTERM
      p.kill('SIGTERM');
    }
    c?.done();
  }
}

/** The player is spawned directly (never through `sh`) so that signals reach it. */
function playerCommand(file: string): [string, string[]] | undefined {
  if (process.platform === 'darwin') return ['afplay', [file]];
  const found = linuxPlayer();
  return found ? linuxPlayerCommand(found, file) : undefined;
}

export const LINUX_PLAYERS = ['pw-play', 'paplay', 'aplay'];

let linuxPlayerCache: { cmd: string; file: string } | null | undefined;
function linuxPlayer(): { cmd: string; file: string } | undefined {
  if (linuxPlayerCache === undefined) linuxPlayerCache = findFirstOnPath(LINUX_PLAYERS) ?? null;
  return linuxPlayerCache ?? undefined;
}

export function linuxPlayerCommand(found: { cmd: string; file: string }, file: string): [string, string[]] {
  return [found.file, found.cmd === 'aplay' ? ['-q', file] : [file]];
}

// --- Windows ------------------------------------------------------------------------------------

export interface WindowsAudioDeps {
  /** Starts the long-lived helper, or returns undefined if it can't run. */
  createHost: (events: WinHostEvents) => WinHostLike | undefined;
  /** Plays one clip in its own process; `kill` stops it without calling `onEnd`. */
  legacyPlay: (file: string, onEnd: () => void) => { kill(): void };
  log: (line: string) => void;
}

interface WinClip {
  id: number;
  file: string;
  done: () => void;
  /** How it is playing right now, if it has started. */
  via?: 'host' | 'legacy';
  legacy?: { kill(): void };
}

/**
 * Clip bookkeeping on top of the helper. Clip ids tie helper events to clips, so a late "ended"
 * for a clip that was already replaced can't end the new one.
 */
export class WindowsAudio implements AudioOut {
  private host: WinHostLike | undefined;
  private hostBroken = false;
  private current: WinClip | undefined;
  private paused = false;
  private nextId = 1;

  constructor(private readonly deps: WindowsAudioDeps) {}

  play(file: string): Promise<void> {
    this.endCurrent();
    return new Promise<void>((done) => {
      this.current = { id: this.nextId++, file, done };
      if (!this.paused) this.start(this.current);
    });
  }

  pause(): void {
    this.paused = true;
    const c = this.current;
    if (c?.via === 'host') {
      this.host?.pause();
    } else if (c?.via === 'legacy') {
      // SoundPlayer can't pause: stop it and replay the sentence on resume.
      c.legacy?.kill();
      c.legacy = undefined;
      c.via = undefined;
    }
  }

  resume(): void {
    this.paused = false;
    const c = this.current;
    if (!c) return;
    if (c.via === 'host') this.host?.resume();
    else if (!c.via) this.start(c);
  }

  stop(): void {
    this.endCurrent();
    this.paused = false;
  }

  dispose(): void {
    this.stop();
    this.host?.dispose();
    this.host = undefined;
  }

  private start(c: WinClip): void {
    const host = this.getHost();
    if (host) {
      c.via = 'host';
      host.play(c.id, c.file);
    } else {
      c.via = 'legacy';
      c.legacy = this.deps.legacyPlay(c.file, () => {
        if (this.current === c && c.via === 'legacy') this.finish(c);
      });
    }
  }

  private getHost(): WinHostLike | undefined {
    if (this.hostBroken) return undefined;
    if (!this.host) {
      this.host = this.deps.createHost({
        ended: (id) => {
          const c = this.current;
          if (c && c.id === id && c.via === 'host') this.finish(c);
        },
        error: (id, message) => this.hostFailed(`clip error: ${message}`, id),
        exit: (code) => this.hostFailed(`helper exited (code ${code})`),
      });
      if (!this.host) this.hostBroken = true;
    }
    return this.host;
  }

  /** Give up on the helper for this session and replay the interrupted clip the old way. */
  private hostFailed(reason: string, id?: number): void {
    if (this.hostBroken) return;
    this.deps.log(`[audio] Windows audio helper failed (${reason}); playing clips with SoundPlayer instead`);
    this.hostBroken = true;
    const host = this.host;
    this.host = undefined;
    host?.dispose();
    const c = this.current;
    if (c && c.via === 'host' && (id === undefined || c.id === id)) {
      c.via = undefined;
      if (!this.paused) this.start(c);
    }
  }

  private endCurrent(): void {
    const c = this.current;
    if (!c) return;
    if (c.via === 'host') this.host?.stop();
    if (c.via === 'legacy') c.legacy?.kill();
    this.finish(c);
  }

  private finish(c: WinClip): void {
    if (this.current === c) this.current = undefined;
    c.via = undefined;
    c.legacy = undefined;
    c.done();
  }
}

/** The pre-helper path: one PowerShell process per clip. Works everywhere, but can't pause. */
function soundPlayer(file: string, onEnd: () => void): { kill(): void } {
  const script = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`;
  const p = spawn(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
  let killed = false;
  const end = () => {
    if (!killed) onEnd();
  };
  p.on('exit', end);
  p.on('error', (err) => {
    console.error('[ShowMe] audio player failed:', err);
    end();
  });
  return {
    kill: () => {
      killed = true;
      p.kill();
    },
  };
}
