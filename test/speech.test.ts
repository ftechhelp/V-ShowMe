import { describe, expect, it } from 'vitest';
import { readingTimeMs, speakCode, splitIdentifier, splitSentences, toSpeech } from '../src/tts/normalize';
import { CancelledError, SpeechQueue } from '../src/tts/speechQueue';

describe('toSpeech', () => {
  it('speaks inline code like a person would', () => {
    expect(toSpeech('First we call `findUserById()` here.')).toBe('First we call find User By Id here.');
    expect(toSpeech('It reads `req.body.email`.')).toBe('It reads req dot body dot email.');
    expect(toSpeech('Open `src/auth/login.ts` next.')).toBe('Open login dot ts next.');
    expect(toSpeech('See `MAX_RETRIES`.')).toBe('See MAX RETRIES.');
  });

  it('strips markdown', () => {
    expect(toSpeech('This is **important** and [documented](http://x).')).toBe('This is important and documented.');
    expect(toSpeech('Look:\n```ts\nconst a = 1;\n```\nDone.')).toBe('Look: Done.');
  });

  it('splits bare identifiers outside backticks', () => {
    expect(toSpeech('The handleLogin function and user_id field.')).toBe('The handle Login function and user id field.');
  });

  it('leaves normal prose alone', () => {
    const prose = "Let's start at the entry point. It's short, but it wires everything together.";
    expect(toSpeech(prose)).toBe(prose);
  });
});

describe('speakCode / splitIdentifier', () => {
  it.each([
    ['parseHTTPRequest', 'parse HTTP Request'],
    ['_privateThing', 'private Thing'],
    ['kebab-case-name', 'kebab case name'],
    ['AuthError', 'Auth Error'],
  ])('%s', (input, expected) => {
    expect(splitIdentifier(input)).toBe(expected);
  });

  it('handles scope operators and optional chaining', () => {
    expect(speakCode('Foo::bar')).toBe('Foo dot bar');
    expect(speakCode('user?.profile')).toBe('user dot profile');
  });
});

describe('splitSentences', () => {
  it('splits on sentence boundaries and merges very short ones', () => {
    const chunks = splitSentences('OK. This first part checks the cache before doing any work. Then it fetches. Finally it returns the result to the caller.');
    expect(chunks[0]).toBe('OK. This first part checks the cache before doing any work.');
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe('Then it fetches. Finally it returns the result to the caller.');
  });

  it('does not split on common abbreviations', () => {
    const chunks = splitSentences('Some values, e.g. timeouts, come from config files on disk. That keeps things flexible.');
    expect(chunks[0]).toContain('e.g. timeouts');
  });

  it('breaks very long sentences at commas', () => {
    const long = Array.from({ length: 30 }, (_, i) => `clause number ${i}`).join(', ') + '.';
    const chunks = splitSentences(long);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(280));
    expect(chunks.join(' ')).toBe(long);
  });
});

describe('readingTimeMs', () => {
  it('has a floor and scales with words', () => {
    expect(readingTimeMs('hi')).toBe(1500);
    expect(readingTimeMs(Array(170).fill('word').join(' '))).toBe(60_000);
  });
});

describe('SpeechQueue', () => {
  function setup() {
    const started: string[] = [];
    const resolvers = new Map<string, (f: string) => void>();
    const queue = new SpeechQueue((key) => {
      started.push(key);
      return new Promise((res) => resolvers.set(key, res));
    });
    const finish = async (key: string) => {
      resolvers.get(key)!(`/clips/${key}.wav`);
      await new Promise((r) => setTimeout(r, 0));
    };
    return { queue, started, finish };
  }

  it('runs one job at a time in request order', async () => {
    const { queue, started, finish } = setup();
    const a = queue.request('a', 'A');
    queue.request('b', 'B');
    expect(started).toEqual(['a']);
    await finish('a');
    await expect(a).resolves.toBe('/clips/a.wav');
    expect(started).toEqual(['a', 'b']);
  });

  it('de-duplicates and caches results', async () => {
    const { queue, started, finish } = setup();
    const p1 = queue.request('a', 'A');
    const p2 = queue.request('a', 'A');
    expect(p1).toBe(p2);
    await finish('a');
    await expect(queue.request('a', 'A')).resolves.toBe('/clips/a.wav');
    expect(started).toEqual(['a']);
  });

  it('reorders pending jobs and cancels unneeded ones', async () => {
    const { queue, started, finish } = setup();
    queue.request('running', 'r');
    const b = queue.request('b', 'B');
    queue.request('c', 'C');
    queue.request('d', 'D');
    queue.prioritize(['d', 'c']);
    await expect(b).rejects.toBeInstanceOf(CancelledError);
    expect(queue.pendingCount).toBe(2);
    await finish('running');
    expect(started).toEqual(['running', 'd']);
    await finish('d');
    expect(started).toEqual(['running', 'd', 'c']);
  });

  it('propagates synthesis errors and keeps going', async () => {
    let n = 0;
    const queue = new SpeechQueue(async (key) => {
      if (n++ === 0) throw new Error('boom');
      return key;
    });
    await expect(queue.request('a', 'A')).rejects.toThrow('boom');
    await expect(queue.request('b', 'B')).resolves.toBe('b');
  });
});
