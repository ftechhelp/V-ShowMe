import { describe, expect, it } from 'vitest';
import { parseLines, parseTour, parseTourText } from '../src/tour/schema';
import { resolveRange } from '../src/tour/anchor';

describe('parseTour', () => {
  it('accepts a well-formed tour', () => {
    const { tour, issues } = parseTour({
      version: 1,
      title: 'How login works',
      steps: [
        { title: 'Handler', file: 'src/login.ts', lines: [12, 18], anchor: 'export function login(', narration: 'Start here.' },
        { narration: 'Recap.' },
      ],
    });
    expect(issues).toEqual([]);
    expect(tour?.steps).toHaveLength(2);
    expect(tour?.steps[0]).toMatchObject({ file: 'src/login.ts', lines: [12, 18], anchor: 'export function login(' });
    expect(tour?.steps[1].file).toBeUndefined();
  });

  it('is lenient about common agent variations', () => {
    const { tour, issues } = parseTour({
      steps: [
        { path: 'a.ts', line: 5, description: 'One line.' },
        { file: 'b.ts', lines: '10-20', text: 'Range as string.' },
      ],
    });
    expect(tour?.title).toBe('Code walkthrough');
    expect(issues).toHaveLength(1); // missing title warning
    expect(tour?.steps[0]).toMatchObject({ file: 'a.ts', lines: [5, 5], narration: 'One line.' });
    expect(tour?.steps[1].lines).toEqual([10, 20]);
  });

  it('skips steps without narration and reports them', () => {
    const { tour, issues } = parseTour({ title: 't', steps: [{ file: 'a.ts' }, { narration: 'ok' }] });
    expect(tour?.steps).toHaveLength(1);
    expect(issues).toEqual([{ step: 1, severity: 'error', message: expect.stringContaining('narration') }]);
  });

  it('keeps a step with bad lines but drops the highlight', () => {
    const { tour, issues } = parseTour({ title: 't', steps: [{ file: 'a.ts', lines: [9, 3], narration: 'x' }] });
    expect(tour?.steps[0].lines).toBeUndefined();
    expect(issues[0]).toMatchObject({ step: 1, severity: 'warning' });
  });

  it('rejects tours without steps and invalid JSON', () => {
    expect(parseTour({ title: 't' }).tour).toBeUndefined();
    expect(parseTour([]).tour).toBeUndefined();
    const bad = parseTourText('{ nope');
    expect(bad.tour).toBeUndefined();
    expect(bad.issues[0].message).toContain('not valid JSON');
  });
});

describe('parseLines', () => {
  it.each([
    [7, [7, 7]],
    [[7], [7, 7]],
    [[7, 9], [7, 9]],
    ['7', [7, 7]],
    ['L7-L9', [7, 9]],
    ['7–9', [7, 9]],
  ])('%j -> %j', (input, expected) => {
    expect(parseLines(input)).toEqual(expected);
  });

  it.each([[0], [[5, 2]], ['abc'], [[1, 2, 3]], [1.5]])('%j is invalid', (input) => {
    expect(parseLines(input)).toBe('invalid');
  });

  it('returns undefined when absent', () => {
    expect(parseLines(undefined)).toBeUndefined();
  });
});

describe('resolveRange', () => {
  const doc = [
    'import x from "y";', // 1
    '',
    'export function login(req) {', // 3
    '  const user = find(req.email);',
    '  return user;',
    '}', // 6
    '',
    'export function logout() {}', // 8
  ];

  it('keeps the range when the anchor matches', () => {
    expect(resolveRange(doc, 3, 6, 'export function login(')).toEqual({ start: 3, end: 6 });
  });

  it('ignores whitespace differences in the anchor', () => {
    expect(resolveRange(doc, 4, 5, 'const user   =  find(req.email);')).toEqual({ start: 4, end: 5 });
  });

  it('shifts the range when lines drifted', () => {
    // Agent thought login() was on line 1..4, but it is on 3..6.
    expect(resolveRange(doc, 1, 4, 'export function login(')).toEqual({ start: 3, end: 6 });
    // Drift in the other direction.
    expect(resolveRange(doc, 7, 7, 'export function logout(')).toEqual({ start: 8, end: 8 });
  });

  it('picks the occurrence nearest the original line', () => {
    const repeated = ['a', 'return user;', 'b', 'c', 'd', 'e', 'return user;', 'f'];
    expect(resolveRange(repeated, 6, 6, 'return user;').start).toBe(7);
    expect(resolveRange(repeated, 3, 3, 'return user;').start).toBe(2);
  });

  it('warns and keeps given lines when the anchor is missing', () => {
    const r = resolveRange(doc, 3, 4, 'does not exist');
    expect(r).toMatchObject({ start: 3, end: 4 });
    expect(r.warning).toContain('not found');
  });

  it('clamps ranges past the end of the file', () => {
    const r = resolveRange(doc, 20, 22);
    expect(r.start).toBeLessThanOrEqual(doc.length);
    expect(r.end).toBe(doc.length);
    expect(r.warning).toContain('past the end');
    expect(resolveRange(doc, 7, 50)).toEqual({ start: 7, end: 8 });
  });
});
