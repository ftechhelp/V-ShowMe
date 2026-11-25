/**
 * Keeps the bundled demo tour honest: every step's anchor must sit exactly on its start line,
 * and every range must exist. Fails when source edits shift the code the demo points at.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parseTourText } from '../src/tour/schema';

const repo = resolve(__dirname, '..');
const { tour, issues } = parseTourText(readFileSync(resolve(repo, 'examples/demo.tour.json'), 'utf8'));

describe('examples/demo.tour.json', () => {
  it('parses cleanly', () => {
    expect(issues).toEqual([]);
    expect(tour).toBeDefined();
  });

  for (const [i, step] of (tour?.steps ?? []).entries()) {
    if (!step.file) continue;
    it(`step ${i + 1} (${step.title}) points at ${step.file}:${step.lines?.join('-')}`, () => {
      const lines = readFileSync(resolve(repo, step.file!), 'utf8').split('\n');
      const [start, end] = step.lines!;
      expect(end).toBeLessThanOrEqual(lines.length);
      expect(end - start + 1).toBeLessThanOrEqual(30);
      expect(lines[start - 1].trim()).toContain(step.anchor!.trim());
    });
  }
});
