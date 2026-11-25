/**
 * Turns caption Markdown into text that sounds natural when spoken, and splits it into
 * sentence-sized chunks so speech can start before the whole step is synthesized.
 */

export function toSpeech(markdown: string): string {
  let s = markdown;

  // Fenced code blocks are not meant to be read aloud.
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Links: keep the label.
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Inline code: speak the identifier.
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => speakCode(code));
  // Emphasis markers.
  s = s.replace(/\*\*|__|(?<!\w)\*(?!\s)|(?<!\s)\*(?!\w)/g, '');
  // Headings / bullets at line start.
  s = s.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/gm, '');
  // Bare identifiers that appear outside backticks.
  s = s.replace(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g, (w) => splitIdentifier(w));
  s = s.replace(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, (w) => splitIdentifier(w));
  s = s.replace(/\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g, (w) => splitIdentifier(w));
  // Common symbols.
  s = s.replace(/\s*=>\s*/g, ' arrow ');
  s = s.replace(/\s&\s/g, ' and ');
  s = s.replace(/[{}[\]<>|#~^]/g, ' ');

  return s.replace(/\s+/g, ' ').trim();
}

/** How a colleague would say a code token out loud. */
export function speakCode(code: string): string {
  let c = code.trim();
  // File paths: just the file name ("login dot ts").
  if (/[\\/]/.test(c) && !/\s/.test(c)) {
    c = c.split(/[\\/]/).filter(Boolean).pop() ?? c;
  }
  // Drop call parentheses and their arguments: foo(bar) -> foo
  c = c.replace(/\([^()]*\)/g, '');
  // Member access / scope operators.
  c = c.replace(/\?\./g, '.').replace(/::|->/g, '.');
  c = c
    .split('.')
    .filter(Boolean)
    .map((part) => splitIdentifier(part))
    .join(' dot ');
  return c.replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** findUserById -> "find User By Id", parseHTTPRequest -> "parse HTTP Request", MAX_RETRIES -> "MAX RETRIES". */
export function splitIdentifier(word: string): string {
  return word
    .replace(/^[_$]+|[_$]+$/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.', 'Mr.', 'Mrs.', 'Dr.', 'approx.'];
const MIN_CHUNK = 40;
const MAX_CHUNK = 280;

/** Splits speech text into chunks of roughly one sentence, merging very short ones. */
export function splitSentences(text: string): string[] {
  let protectedText = text;
  ABBREVIATIONS.forEach((abbr, i) => {
    protectedText = protectedText.split(abbr).join(`\u0000${i}\u0000`);
  });

  const raw = protectedText
    .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])|\n{2,}/)
    .map((s) => s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => ABBREVIATIONS[Number(i)]).trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const sentence of raw.flatMap(splitLong)) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length < MIN_CHUNK && last.length + sentence.length + 1 <= MAX_CHUNK) {
      chunks[chunks.length - 1] = `${last} ${sentence}`;
    } else {
      chunks.push(sentence);
    }
  }
  return chunks;
}

function splitLong(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    const cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '), window.lastIndexOf(' — '));
    const at = cut > MIN_CHUNK ? cut + 1 : window.lastIndexOf(' ');
    if (at <= 0) break;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Rough reading time for captions-only mode. */
export function readingTimeMs(text: string, wordsPerMinute = 170): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1500, Math.round((words / wordsPerMinute) * 60_000));
}
