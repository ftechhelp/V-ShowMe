/**
 * Plays audio files through the OS player. On macOS and Linux, pause/resume use SIGSTOP/SIGCONT,
 * which freezes playback mid-sentence. On Windows, pause stops the clip and resume replays it.
 */
import { ChildProcess, spawn } from 'child_process';
import type { AudioOut } from '../player/player';

export class AudioPlayer implements AudioOut {
  private proc: ChildProcess | undefined;
  private current: { file: string; done: () => void } | undefined;
  private paused = false;

  play(file: string): Promise<void> {
    this.kill();
    return new Promise<void>((done) => {
      this.current = { file, done };
      if (this.paused && !canSuspend()) return; // Windows: start on resume
      this.spawn(file);
    });
  }

  pause(): void {
    this.paused = true;
    if (!this.proc) return;
    if (canSuspend()) {
      this.proc.kill('SIGSTOP');
    } else {
      // No SIGSTOP on Windows: kill the player but keep the clip pending so resume replays it.
      const p = this.proc;
      this.proc = undefined;
      p.removeAllListeners('exit');
      p.kill();
    }
  }

  resume(): void {
    this.paused = false;
    if (this.proc) {
      if (canSuspend()) this.proc.kill('SIGCONT');
    } else if (this.current) {
      this.spawn(this.current.file);
    }
  }

  stop(): void {
    this.kill();
    this.paused = false;
  }

  /** Ends the current clip (resolving its play() promise) without touching the paused flag. */
  private kill(): void {
    const p = this.proc;
    const c = this.current;
    this.proc = undefined;
    this.current = undefined;
    if (p) {
      p.removeAllListeners('exit');
      if (canSuspend()) p.kill('SIGCONT'); // a stopped process would ignore SIGTERM
      p.kill('SIGTERM');
    }
    c?.done();
  }

  private spawn(file: string): void {
    const [cmd, args] = playerCommand(file);
    const p = spawn(cmd, args, { stdio: 'ignore' });
    this.proc = p;
    if (this.paused && canSuspend()) p.kill('SIGSTOP');
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
  }
}

function canSuspend(): boolean {
  return process.platform !== 'win32';
}

function playerCommand(file: string): [string, string[]] {
  switch (process.platform) {
    case 'darwin':
      return ['afplay', [file]];
    case 'win32':
      return [
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`],
      ];
    default:
      // PulseAudio/PipeWire first, ALSA as fallback (resolved via sh so a missing paplay falls through).
      return ['sh', ['-c', 'paplay "$0" 2>/dev/null || aplay -q "$0"', file]];
  }
}
