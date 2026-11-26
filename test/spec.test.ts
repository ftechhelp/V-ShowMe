/**
 * Runs the shared behaviour vectors in spec/ against the TypeScript implementation. The C# port
 * (visualstudio/test/ShowMe.Core.Tests) runs the same files, which keeps the VS Code and Visual
 * Studio extensions in step. Regenerate with `node scripts/update-spec.mjs` after an intended change.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveRange } from '../src/tour/anchor';
import { parseLines, parseTour, parseTourText } from '../src/tour/schema';
import { readingTimeMs, speakCode, splitIdentifier, splitSentences, toSpeech } from '../src/tts/normalize';

const load = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', name), 'utf8'));
const tourSpec = load('tour.json');
const anchorSpec = load('anchor.json');
const speechSpec = load('speech.json');

interface ExpectedIssue {
  step?: number;
  severity: string;
  message?: string;
  messageStartsWith?: string;
}

describe('spec/tour.json', () => {
  it.each<[string, any]>(tourSpec.parseTour.map((c: any): [string, any] => [c.name, c]))('parseTour: %s', (_name, c: any) => {
    const result = 'text' in c ? parseTourText(c.text) : parseTour(c.json);
    expect(result.tour ?? null).toEqual(c.expect.tour);
    expect(result.issues).toHaveLength(c.expect.issues.length);
    c.expect.issues.forEach((want: ExpectedIssue, i: number) => {
      const got = result.issues[i];
      expect(got.step).toBe(want.step);
      expect(got.severity).toBe(want.severity);
      if (want.messageStartsWith) expect(got.message.startsWith(want.messageStartsWith)).toBe(true);
      else expect(got.message).toBe(want.message);
    });
  });

  it.each<[string, any]>(tourSpec.parseLines.map((c: any): [string, any] => [JSON.stringify(c.input), c]))('parseLines(%s)', (_name, c: any) => {
    expect(parseLines(c.input) ?? null).toEqual(c.expect);
  });
});

describe('spec/anchor.json', () => {
  it.each<[string, any]>(anchorSpec.resolveRange.map((c: any): [string, any] => [c.name, c]))('resolveRange: %s', (_name, c: any) => {
    expect(resolveRange(anchorSpec.docs[c.doc], c.start, c.end, c.anchor)).toEqual(c.expect);
  });
});

describe('spec/speech.json', () => {
  const fns: Record<string, (input: any) => unknown> = { toSpeech, speakCode, splitIdentifier, splitSentences, readingTimeMs };
  for (const [name, fn] of Object.entries(fns)) {
    it.each<[string, any]>(speechSpec[name].map((c: any): [string, any] => [JSON.stringify(c.input).slice(0, 50), c]))(`${name}(%s)`, (_label, c: any) => {
      expect(fn(c.input)).toEqual(c.expect);
    });
  }
});
