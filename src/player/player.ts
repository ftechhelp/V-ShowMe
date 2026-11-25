/**
 * Tour playback state machine. Knows nothing about VS Code: the editor, the speech engine and
 * the audio output are injected, which keeps this unit-testable.
 *
 *   idle ──start──▶ playing ──pause──▶ paused ──resume──▶ playing
 *                     │  ▲                                   │
 *                     │  └──────── next / previous / goto ───┘
 *                     ├─ narration done, autoAdvance off ──▶ waiting ──next──▶ playing
 *                     └─ last step done ──────────────────▶ finished
 */
import { CancelledError } from '../tts/speechQueue';

export type PlayerState = 'idle' | 'playing' | 'paused' | 'waiting' | 'finished';

export interface Narrator {
  /** Clip files for a step, in speaking order. Empty means captions only. */
  clips(index: number): Promise<string>[];
  /** Steps that will be needed soon, most urgent first. */
  prefetch(indices: number[]): void;
  /** How long to stay on a step when there is no audio. */
  silentDurationMs(index: number): number;
}

export interface AudioOut {
  /** Resolves when the clip finished playing or was stopped. Never rejects. */
  play(file: string): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface PlayerHost {
  /** Show step `index` in the editor (open file, highlight, caption). */
  present(index: number): Promise<void>;
  /** State or step changed. */
  changed(): void;
  options(): { autoAdvance: boolean; pauseBetweenStepsMs: number };
  error(err: unknown, index: number): void;
}

export class Player {
  state: PlayerState = 'idle';
  index = 0;
  total = 0;

  private generation = 0;
  private readonly gate = new Gate();

  constructor(
    private readonly narrator: Narrator,
    private readonly audio: AudioOut,
    private readonly host: PlayerHost,
  ) {}

  start(total: number, index = 0): void {
    this.total = total;
    this.goto(index);
  }

  goto(index: number): void {
    if (this.total === 0) return;
    const target = Math.min(Math.max(index, 0), this.total - 1);
    const gen = ++this.generation;
    this.audio.stop();
    this.gate.open();
    this.index = target;
    this.setState('playing');
    void this.run(target, gen);
  }

  next(): void {
    if (this.state === 'idle') return;
    if (this.index < this.total - 1) {
      this.goto(this.index + 1);
    } else {
      this.generation++;
      this.audio.stop();
      this.gate.open();
      this.setState('finished');
    }
  }

  previous(): void {
    if (this.state === 'idle') return;
    this.goto(this.index - 1);
  }

  replay(): void {
    if (this.state === 'idle') return;
    this.goto(this.index);
  }

  togglePause(): void {
    switch (this.state) {
      case 'playing':
        return this.pause();
      case 'paused':
        return this.resume();
      case 'waiting':
        return this.next();
      case 'finished':
        return this.goto(0);
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.gate.close();
    this.audio.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.gate.open();
    this.audio.resume();
    this.setState('playing');
  }

  stop(): void {
    this.generation++;
    this.audio.stop();
    this.gate.open();
    this.total = 0;
    this.index = 0;
    this.setState('idle');
  }

  private async run(index: number, gen: number): Promise<void> {
    const alive = () => gen === this.generation;
    try {
      await this.host.present(index);
      if (!alive()) return;

      this.narrator.prefetch(range(index, this.total));
      const clips = this.narrator.clips(index);

      if (clips.length === 0) {
        await this.sleep(this.narrator.silentDurationMs(index));
        if (!alive()) return;
      }

      for (const clip of clips) {
        let file: string;
        try {
          file = await clip;
        } catch (err) {
          if (!alive() || err instanceof CancelledError) return;
          this.host.error(err, index);
          continue;
        }
        if (!alive()) return;
        await this.gate.wait();
        if (!alive()) return;
        await this.audio.play(file);
        if (!alive()) return;
      }

      if (index >= this.total - 1) {
        this.setState('finished');
        return;
      }

      const { autoAdvance, pauseBetweenStepsMs } = this.host.options();
      if (!autoAdvance) {
        this.setState('waiting');
        return;
      }

      await this.sleep(pauseBetweenStepsMs);
      if (!alive()) return;
      this.index = index + 1;
      this.host.changed();
      await this.run(index + 1, gen);
    } catch (err) {
      if (alive()) this.host.error(err, index);
    }
  }

  /** Delay that also honours pause. */
  private async sleep(ms: number): Promise<void> {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    await this.gate.wait();
  }

  private setState(state: PlayerState): void {
    this.state = state;
    this.host.changed();
  }
}

class Gate {
  private closed = false;
  private waiters: Array<() => void> = [];

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.closed = false;
    this.waiters.splice(0).forEach((w) => w());
  }

  wait(): Promise<void> {
    return this.closed ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}
