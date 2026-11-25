/**
 * Re-locates a step's line range when the file changed since the agent read it.
 *
 * The agent records the text of the first highlighted line as `anchor`. If that text is no
 * longer on the start line, we look for the occurrence nearest to the original position and
 * shift the whole range by the same amount.
 */

export interface ResolvedRange {
  /** 1-based inclusive. */
  start: number;
  end: number;
  warning?: string;
}

export function resolveRange(
  docLines: readonly string[],
  start: number,
  end: number,
  anchor?: string,
): ResolvedRange {
  const lineCount = Math.max(docLines.length, 1);
  let warning: string | undefined;

  const needle = anchor ? normalize(anchor.split(/\r?\n/).find((l) => l.trim()) ?? '') : '';
  if (needle) {
    const startIdx = start - 1;
    const onStartLine = startIdx >= 0 && startIdx < docLines.length && normalize(docLines[startIdx]).includes(needle);
    if (!onStartLine) {
      const found = nearestMatch(docLines, needle, startIdx);
      if (found !== undefined) {
        const delta = found - startIdx;
        start += delta;
        end += delta;
      } else {
        warning = `Anchor ${JSON.stringify(anchor)} not found in file; using lines ${start}-${end} as given.`;
      }
    }
  }

  if (start > lineCount) {
    const msg = `Lines ${start}-${end} are past the end of the file (${lineCount} lines).`;
    warning = warning ? `${warning} ${msg}` : msg;
    const span = end - start;
    start = Math.max(1, lineCount - span);
    end = lineCount;
  }
  end = Math.min(Math.max(end, start), lineCount);

  return { start, end, warning };
}

function nearestMatch(lines: readonly string[], needle: string, around: number): number | undefined {
  let best: number | undefined;
  let bestDist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i]).includes(needle)) {
      const dist = Math.abs(i - around);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
  }
  return best;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
