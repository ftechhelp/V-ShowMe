import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioOut, Narrator, Player, PlayerHost } from '../src/player/player';

/**
 * Fake engine: each step has `clipsPerStep` clips that synthesize instantly; each clip "plays"
 * for 1000 ms of fake time. Pause freezes the remaining play time like SIGSTOP would.
 */
function setup(opts: { total?: number; clipsPerStep?: number; autoAdvance?: boolean; gap?: number } = {}) {
  const total = opts.total ?? 3;
  const clipsPerStep = opts.clipsPerStep ?? 2;
  const log: string[] = [];
  const prefetches: number[][] = [];

  const narrator: Narrator = {
    clips: (i) => Array.from({ length: clipsPerStep }, (_, c) => Promise.resolve(`s${i}c${c}`)),
    prefetch: (indices) => prefetches.push(indices),
    silentDurationMs: () => 500,
  };

  let current: { file: string; remaining: number; done: () => void; timer?: ReturnType<typeof setTimeout>; startedAt: number } | undefined;
  let paused = false;
  const startTimer = () => {
    if (!current) return;
    const c = current;
    c.startedAt = Date.now();
    c.timer = setTimeout(() => {
      log.push(`end ${c.file}`);
      current = undefined;
      c.done();
    }, c.remaining);
  };
  const audio: AudioOut = {
    play: (file) =>
      new Promise<void>((done) => {
        log.push(`play ${file}`);
        current = { file, remaining: 1000, done, startedAt: 0 };
        if (!paused) startTimer();
      }),
    pause: () => {
      paused = true;
      if (current?.timer) {
        clearTimeout(current.timer);
        current.remaining -= Date.now() - current.startedAt;
        current.timer = undefined;
      }
    },
    resume: () => {
      paused = false;
      if (current && !current.timer) startTimer();
    },
    stop: () => {
      paused = false;
      if (current) {
        clearTimeout(current.timer);
        log.push(`stop ${current.file}`);
        const c = current;
        current = undefined;
        c.done();
      }
    },
  };

  const host: PlayerHost = {
    present: async (i) => {
      log.push(`present ${i}`);
    },
    changed: vi.fn(),
    options: () => ({ autoAdvance: opts.autoAdvance ?? true, pauseBetweenStepsMs: opts.gap ?? 100 }),
    error: (err) => log.push(`error ${String(err)}`),
  };

  const player = new Player(narrator, audio, host);
  return { player, log, prefetches, total };
}

describe('Player', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays every clip of every step in order, then finishes', async () => {
    const { player, log, total } = setup();
    player.start(total);
    await vi.runAllTimersAsync();
    expect(log).toEqual([
      'present 0', 'play s0c0', 'end s0c0', 'play s0c1', 'end s0c1',
      'present 1', 'play s1c0', 'end s1c0', 'play s1c1', 'end s1c1',
      'present 2', 'play s2c0', 'end s2c0', 'play s2c1', 'end s2c1',
    ]);
    expect(player.state).toBe('finished');
    expect(player.index).toBe(2);
  });

  it('prefetches the current step first, then the rest', async () => {
    const { player, prefetches, total } = setup();
    player.start(total);
    await vi.advanceTimersByTimeAsync(10);
    expect(prefetches[0]).toEqual([0, 1, 2]);
  });

  it('pauses mid-clip and resumes where it left off', async () => {
    const { player, log, total } = setup({ total: 1, clipsPerStep: 1 });
    player.start(total);
    await vi.advanceTimersByTimeAsync(400);
    player.togglePause();
    expect(player.state).toBe('paused');
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).not.toContain('end s0c0');
    player.togglePause();
    expect(player.state).toBe('playing');
    await vi.advanceTimersByTimeAsync(599);
    expect(log).not.toContain('end s0c0');
    await vi.advanceTimersByTimeAsync(2);
    expect(log).toContain('end s0c0');
    expect(player.state).toBe('finished');
  });

  it('does not start the next clip while paused between clips', async () => {
    const { player, log, total } = setup({ total: 1, clipsPerStep: 2 });
    player.start(total);
    await vi.advanceTimersByTimeAsync(1000); // first clip ends
    player.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(log.filter((l) => l.startsWith('play'))).toEqual(['play s0c0', 'play s0c1']);
    // second clip was spawned but is frozen
    expect(log).not.toContain('end s0c1');
    player.resume();
    await vi.runAllTimersAsync();
    expect(log).toContain('end s0c1');
  });

  it('next/previous interrupt the current narration', async () => {
    const { player, log, total } = setup();
    player.start(total);
    await vi.advanceTimersByTimeAsync(300);
    player.next();
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toEqual(['present 0', 'play s0c0', 'stop s0c0', 'present 1', 'play s1c0']);
    player.previous();
    await vi.advanceTimersByTimeAsync(10);
    expect(player.index).toBe(0);
    expect(log.slice(-3)).toEqual(['stop s1c0', 'present 0', 'play s0c0']);
  });

  it('next on the last step finishes the tour', async () => {
    const { player, total } = setup();
    player.start(total, 2);
    await vi.advanceTimersByTimeAsync(10);
    player.next();
    expect(player.state).toBe('finished');
  });

  it('waits for the user when autoAdvance is off', async () => {
    const { player, log, total } = setup({ autoAdvance: false });
    player.start(total);
    await vi.runAllTimersAsync();
    expect(player.state).toBe('waiting');
    expect(log).not.toContain('present 1');
    player.togglePause(); // acts as "next" while waiting
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toContain('present 1');
  });

  it('honours the pause between steps', async () => {
    const { player, log, total } = setup({ clipsPerStep: 1, gap: 2000 });
    player.start(total);
    await vi.advanceTimersByTimeAsync(1000 + 1999);
    expect(log).not.toContain('present 1');
    await vi.advanceTimersByTimeAsync(2);
    expect(log).toContain('present 1');
  });

  it('stop halts everything and resets', async () => {
    const { player, log, total } = setup();
    player.start(total);
    await vi.advanceTimersByTimeAsync(300);
    player.stop();
    await vi.runAllTimersAsync();
    expect(player.state).toBe('idle');
    expect(log).toEqual(['present 0', 'play s0c0', 'stop s0c0']);
  });

  it('togglePause on a finished tour restarts it', async () => {
    const { player, log, total } = setup({ total: 1, clipsPerStep: 1 });
    player.start(total);
    await vi.runAllTimersAsync();
    player.togglePause();
    await vi.advanceTimersByTimeAsync(10);
    expect(log.filter((l) => l === 'present 0')).toHaveLength(2);
  });
});
