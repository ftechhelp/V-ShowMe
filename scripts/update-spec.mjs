#!/usr/bin/env node
/**
 * Regenerates every `expect` in spec/*.json from the TypeScript implementation. Run it after an
 * intentional behaviour change, review the diff, and make the C# port (visualstudio/) match.
 *
 *   node scripts/update-spec.mjs           rewrite the files
 *   node scripts/update-spec.mjs --check   exit 1 if any file would change
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const check = process.argv.includes('--check');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showme-spec-'));
const bundle = path.join(tmp, 'impl.cjs');
await require('esbuild').build({
  stdin: {
    contents: `export * from './src/tour/schema'; export * from './src/tour/anchor'; export * from './src/tts/normalize';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'silent',
});
const impl = require(bundle);
fs.rmSync(tmp, { recursive: true, force: true });

const INVALID_JSON = 'Tour is not valid JSON: ';
const nullify = (v) => (v === undefined ? null : v);

const generators = {
  'tour.json': (spec) => {
    for (const c of spec.parseTour) {
      const result = 'text' in c ? impl.parseTourText(c.text) : impl.parseTour(c.json);
      // The JSON parser's own error text differs between runtimes; only the prefix is shared.
      const issues = result.issues.map((i) =>
        i.message.startsWith(INVALID_JSON) ? { ...i, message: undefined, messageStartsWith: INVALID_JSON } : i,
      );
      c.expect = { tour: nullify(result.tour), issues: JSON.parse(JSON.stringify(issues)) };
    }
    for (const c of spec.parseLines) c.expect = nullify(impl.parseLines(c.input));
  },
  'anchor.json': (spec) => {
    for (const c of spec.resolveRange) {
      c.expect = impl.resolveRange(spec.docs[c.doc], c.start, c.end, c.anchor);
      if (c.expect.warning === undefined) delete c.expect.warning;
    }
  },
  'speech.json': (spec) => {
    for (const fn of ['toSpeech', 'speakCode', 'splitIdentifier', 'splitSentences', 'readingTimeMs']) {
      for (const c of spec[fn]) c.expect = impl[fn](c.input);
    }
  },
};

let stale = false;
for (const [file, generate] of Object.entries(generators)) {
  const full = path.join(ROOT, 'spec', file);
  const before = fs.readFileSync(full, 'utf8');
  const spec = JSON.parse(before);
  generate(spec);
  const after = JSON.stringify(spec, null, 2) + '\n';
  if (after === before) continue;
  stale = true;
  if (check) console.log(`spec/${file} is out of date`);
  else {
    fs.writeFileSync(full, after);
    console.log(`updated spec/${file}`);
  }
}
if (check && stale) {
  console.log('Run `node scripts/update-spec.mjs` and review the diff.');
  process.exit(1);
}
