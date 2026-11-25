/**
 * Tour file format (v1) and a lenient validator.
 *
 * Tours are written by an agent, so the validator accepts a few common variations
 * (`line` instead of `lines`, "12-18" strings, `description` instead of `narration`)
 * and reports problems as issues instead of throwing.
 */

export interface TourStep {
  /** Short label for the step list. */
  title?: string;
  /** Path relative to the tour root (normally the workspace folder). */
  file?: string;
  /** 1-based inclusive line range. Only present when `file` is. */
  lines?: [number, number];
  /** Verbatim text expected on the first highlighted line, used to re-locate drifted ranges. */
  anchor?: string;
  /** What gets said (and shown as the caption). Markdown allowed. */
  narration: string;
}

export interface Tour {
  version: 1;
  title: string;
  /** Optional directory, relative to the tour file, that step paths resolve against. */
  root?: string;
  steps: TourStep[];
}

export interface TourIssue {
  /** 1-based step number, absent for tour-level issues. */
  step?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface ParseResult {
  tour?: Tour;
  issues: TourIssue[];
}

export function parseTourText(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { issues: [{ severity: 'error', message: `Tour is not valid JSON: ${(err as Error).message}` }] };
  }
  return parseTour(json);
}

export function parseTour(json: unknown): ParseResult {
  const issues: TourIssue[] = [];
  if (!isObject(json)) {
    return { issues: [{ severity: 'error', message: 'Tour must be a JSON object.' }] };
  }

  const rawSteps = json.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { issues: [{ severity: 'error', message: 'Tour must have a non-empty "steps" array.' }] };
  }

  let title = typeof json.title === 'string' && json.title.trim() ? json.title.trim() : '';
  if (!title) {
    title = 'Code walkthrough';
    issues.push({ severity: 'warning', message: 'Tour has no "title"; using "Code walkthrough".' });
  }

  const steps: TourStep[] = [];
  rawSteps.forEach((raw, i) => {
    const stepNo = i + 1;
    if (!isObject(raw)) {
      issues.push({ step: stepNo, severity: 'error', message: 'Step must be an object; skipped.' });
      return;
    }

    const narration = firstString(raw.narration, raw.description, raw.text);
    if (!narration) {
      issues.push({ step: stepNo, severity: 'error', message: 'Step has no "narration"; skipped.' });
      return;
    }

    const step: TourStep = { narration };
    const title = firstString(raw.title);
    if (title) step.title = title;

    const file = firstString(raw.file, raw.path);
    if (file) {
      step.file = file;
      const lines = parseLines(raw.lines ?? raw.line);
      if (lines === 'invalid') {
        issues.push({
          step: stepNo,
          severity: 'warning',
          message: `Invalid "lines" (${JSON.stringify(raw.lines ?? raw.line)}); expected [start, end] with 1 <= start <= end. The file will open without a highlight.`,
        });
      } else if (lines) {
        step.lines = lines;
      }
      const anchor = firstString(raw.anchor);
      if (anchor) step.anchor = anchor;
    } else if (raw.lines !== undefined || raw.line !== undefined) {
      issues.push({ step: stepNo, severity: 'warning', message: '"lines" given without "file"; ignored.' });
    }

    steps.push(step);
  });

  if (steps.length === 0) {
    issues.push({ severity: 'error', message: 'No playable steps.' });
    return { issues };
  }

  const tour: Tour = { version: 1, title, steps };
  const root = firstString(json.root);
  if (root) tour.root = root;
  return { tour, issues };
}

/** Accepts 12, [12], [12, 18], "12", "12-18", "L12-L18". */
export function parseLines(value: unknown): [number, number] | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;

  let start: number | undefined;
  let end: number | undefined;

  if (typeof value === 'number') {
    start = end = value;
  } else if (Array.isArray(value) && value.length >= 1 && value.length <= 2) {
    start = Number(value[0]);
    end = value.length === 2 ? Number(value[1]) : start;
  } else if (typeof value === 'string') {
    const m = /^\s*L?(\d+)\s*(?:[-–:]\s*L?(\d+))?\s*$/i.exec(value);
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : start;
    }
  }

  if (
    start === undefined ||
    end === undefined ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start
  ) {
    return 'invalid';
  }
  return [start, end];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
