import { describe, expect, it } from 'vitest';
import { WindowsAudio, WindowsAudioDeps, linuxPlayerCommand } from '../src/tts/audioPlayer';
import { encodePowerShell, sapiRate } from '../src/tts/systemVoice';
import { WinHostEvents, WinHostLike, parseHostLine } from '../src/tts/winAudioHost';
import { findFirstOnPath, findOnPath } from '../src/util/which';

describe('findOnPath', () => {
  const posix = (files: string[], PATH = '/usr/local/bin:/usr/bin') => ({
    platform: 'linux' as const,
    env: { PATH },
    isExecutable: (f: string) => files.includes(f),
  });

  it('returns the first match in PATH order', () => {
    expect(findOnPath('paplay', posix(['/usr/bin/paplay', '/usr/local/bin/paplay']))).toBe('/usr/local/bin/paplay');
    expect(findOnPath('paplay', posix([]))).toBeUndefined();
  });

  it('tries candidates in order of preference', () => {
    const env = posix(['/usr/bin/aplay', '/usr/bin/paplay']);
    expect(findFirstOnPath(['pw-play', 'paplay', 'aplay'], env)).toEqual({ cmd: 'paplay', file: '/usr/bin/paplay' });
  });

  it('applies PATHEXT on Windows', () => {
    const env = {
      platform: 'win32' as const,
      env: { Path: 'C:\\Windows\\System32;C:\\Tools', PATHEXT: '.COM;.EXE' },
      isExecutable: (f: string) => f === 'C:\\Tools\\espeak-ng.EXE',
    };
    expect(findOnPath('espeak-ng', env)).toBe('C:\\Tools\\espeak-ng.EXE');
  });
});

describe('Linux player', () => {
  it('runs the player itself, never a shell, so signals reach it', () => {
    expect(linuxPlayerCommand({ cmd: 'pw-play', file: '/usr/bin/pw-play' }, '/tmp/a.wav')).toEqual(['/usr/bin/pw-play', ['/tmp/a.wav']]);
    expect(linuxPlayerCommand({ cmd: 'aplay', file: '/usr/bin/aplay' }, '/tmp/a.wav')).toEqual(['/usr/bin/aplay', ['-q', '/tmp/a.wav']]);
  });
});

describe('Windows speech helpers', () => {
  it('maps speed to the SAPI rate scale', () => {
    expect(sapiRate(1)).toBe(0);
    expect(sapiRate(3)).toBe(10);
    expect(sapiRate(1 / 3)).toBe(-10);
    expect(sapiRate(10)).toBe(10);
    expect(sapiRate(1.5)).toBe(4);
  });

  it('encodes scripts as base64 UTF-16LE for -EncodedCommand', () => {
    expect(Buffer.from(encodePowerShell('ä$x'), 'base64').toString('utf16le')).toBe('ä$x');
  });

  it('parses helper output lines', () => {
    expect(parseHostLine('ready')).toEqual({ type: 'ready' });
    expect(parseHostLine('ended 12\r')).toEqual({ type: 'ended', id: 12 });
    expect(parseHostLine('error 3 MCI 263: The specified device is not open.')).toEqual({
      type: 'error',
      id: 3,
      message: 'MCI 263: The specified device is not open.',
    });
    expect(parseHostLine('error - bad command')).toEqual({ type: 'error', id: undefined, message: 'bad command' });
    expect(parseHostLine('ended')).toBeUndefined();
    expect(parseHostLine('Add-Type : something')).toBeUndefined();
  });
});

describe('WindowsAudio', () => {
  function setup(opts: { hostStarts?: boolean } = {}) {
    const calls: string[] = [];
    let events: WinHostEvents | undefined;
    const legacy: Array<{ file: string; end: () => void; killed: boolean }> = [];
    const deps: WindowsAudioDeps = {
      createHost: (e) => {
        calls.push('start');
        if (opts.hostStarts === false) return undefined;
        events = e;
        const host: WinHostLike = {
          play: (id, file) => calls.push(`play ${id} ${file}`),
          pause: () => calls.push('pause'),
          resume: () => calls.push('resume'),
          stop: () => calls.push('stop'),
          dispose: () => calls.push('dispose'),
        };
        return host;
      },
      legacyPlay: (file, onEnd) => {
        const entry = { file, end: onEnd, killed: false };
        legacy.push(entry);
        calls.push(`legacy ${file}`);
        return { kill: () => (entry.killed = true) };
      },
      log: () => undefined,
    };
    return { audio: new WindowsAudio(deps), calls, legacy, events: () => events! };
  }

  const settled = async (p: Promise<void>) => {
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    return done;
  };

  it('starts the helper once and resolves when the clip ends', async () => {
    const { audio, calls, events } = setup();
    const a = audio.play('a.wav');
    expect(calls).toEqual(['start', 'play 1 a.wav']);
    events().ended(1);
    expect(await settled(a)).toBe(true);
    const b = audio.play('b.wav');
    expect(calls).toEqual(['start', 'play 1 a.wav', 'play 2 b.wav']);
    events().ended(2);
    expect(await settled(b)).toBe(true);
  });

  it('pauses and resumes inside the helper', async () => {
    const { audio, calls, events } = setup();
    const a = audio.play('a.wav');
    audio.pause();
    audio.resume();
    expect(calls).toEqual(['start', 'play 1 a.wav', 'pause', 'resume']);
    expect(await settled(a)).toBe(false);
    events().ended(1);
    expect(await settled(a)).toBe(true);
  });

  it('ignores a late "ended" for a clip that was replaced', async () => {
    const { audio, calls, events } = setup();
    const a = audio.play('a.wav');
    const b = audio.play('b.wav');
    expect(await settled(a)).toBe(true);
    expect(calls).toEqual(['start', 'play 1 a.wav', 'stop', 'play 2 b.wav']);
    events().ended(1);
    expect(await settled(b)).toBe(false);
  });

  it('waits for resume when a clip is queued while paused', async () => {
    const { audio, calls } = setup();
    audio.pause();
    void audio.play('a.wav');
    expect(calls).toEqual([]);
    audio.resume();
    expect(calls).toEqual(['start', 'play 1 a.wav']);
  });

  it('falls back to SoundPlayer for the rest of the session when the helper fails', async () => {
    const { audio, calls, legacy, events } = setup();
    const a = audio.play('a.wav');
    events().error(1, 'MCI 263');
    expect(calls).toEqual(['start', 'play 1 a.wav', 'dispose', 'legacy a.wav']);
    legacy[0].end();
    expect(await settled(a)).toBe(true);
    void audio.play('b.wav');
    expect(calls.at(-1)).toBe('legacy b.wav');
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
  });

  it('uses SoundPlayer when the helper cannot start, replaying the sentence after a pause', async () => {
    const { audio, legacy } = setup({ hostStarts: false });
    const a = audio.play('a.wav');
    expect(legacy.map((l) => l.file)).toEqual(['a.wav']);
    audio.pause();
    expect(legacy[0].killed).toBe(true);
    legacy[0].end(); // a killed process exiting must not end the clip
    expect(await settled(a)).toBe(false);
    audio.resume();
    expect(legacy.map((l) => l.file)).toEqual(['a.wav', 'a.wav']);
    legacy[1].end();
    expect(await settled(a)).toBe(true);
  });

  it('stop ends the clip and clears pause', async () => {
    const { audio, calls } = setup();
    const a = audio.play('a.wav');
    audio.pause();
    audio.stop();
    expect(await settled(a)).toBe(true);
    void audio.play('b.wav');
    expect(calls.at(-1)).toBe('play 2 b.wav');
  });
});
