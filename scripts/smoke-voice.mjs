#!/usr/bin/env node
/**
 * Smoke test for speech on the current OS, run in CI on macOS, Windows and Linux.
 *
 *   node scripts/smoke-voice.mjs --extension <unzipped VSIX>/extension --models <dir> [--dtype q8|fp32]
 *                                [--skip-kokoro] [--skip-system] [--require-system]
 *
 * 1. Kokoro: forks dist/kokoroWorker.js from the packaged extension with plain Node, loads (or
 *    downloads) the model and synthesizes one sentence. The VSIX has no sharp, so this also proves
 *    the sharp stub and the per-platform onnxruntime binaries.
 * 2. System voice: `say`, SAPI or espeak-ng writes one sentence to a file.
 * 3. Windows only: the long-lived audio helper compiles and answers. CI runners have no sound
 *    card, so a playback error is reported but not treated as a failure.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const extensionDir = path.resolve(opt('--extension', ROOT));
const modelsDir = path.resolve(opt('--models', path.join(ROOT, '.e2e', 'smoke-models')));
const dtype = opt('--dtype', 'q8');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'showme-smoke-'));
const SENTENCE = 'Here we check that the ShowMe narrator can speak on this machine.';

let failed = false;
const ok = (msg) => console.log(`ok    ${msg}`);
const fail = (msg) => {
  failed = true;
  console.log(`FAIL  ${msg}`);
};
const skip = (msg) => console.log(`skip  ${msg}`);

function checkAudioFile(file, what) {
  if (!fs.existsSync(file)) return fail(`${what}: no file written`);
  const size = fs.statSync(file).size;
  const magic = fs.readFileSync(file).subarray(0, 4).toString('latin1');
  if (size < 10_000) return fail(`${what}: file is only ${size} bytes`);
  if (magic !== 'RIFF' && magic !== 'FORM') return fail(`${what}: not a WAV/AIFF file (starts with ${JSON.stringify(magic)})`);
  ok(`${what}: ${path.basename(file)}, ${(size / 1024).toFixed(0)} KB`);
}

async function kokoro() {
  const worker = path.join(extensionDir, 'dist', 'kokoroWorker.js');
  if (!fs.existsSync(worker)) return fail(`Kokoro: ${worker} not found (build or unzip the VSIX first)`);
  const sharpShipped = fs.existsSync(path.join(extensionDir, 'node_modules', 'sharp'));
  console.log(`Kokoro worker ${worker} (${dtype}, models in ${modelsDir}, sharp ${sharpShipped ? 'present' : 'absent'})`);
  fs.mkdirSync(modelsDir, { recursive: true });

  const proc = fork(worker, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const outFile = path.join(out, 'kokoro.wav');
  let lastPct = -10;
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timed out after 15 minutes'), 15 * 60_000);
    const finish = (r) => {
      clearTimeout(timer);
      resolve(r);
    };
    proc.on('exit', (code) => finish(`worker exited with code ${code}`));
    proc.on('message', (msg) => {
      if (msg.type === 'progress') {
        const pct = Math.floor((msg.loaded / msg.total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          console.log(`      downloading ${msg.file}: ${pct}%`);
        }
      } else if (msg.type === 'ready') {
        console.log(`      model ready in ${msg.loadMs} ms`);
        proc.send({ type: 'synth', id: 1, text: SENTENCE, voice: 'af_heart', speed: 1, outFile });
      } else if (msg.type === 'initFailed') {
        finish(`init failed: ${msg.message}`);
      } else if (msg.type === 'done') {
        console.log(`      synthesized in ${msg.ms} ms`);
        finish('done');
      } else if (msg.type === 'failed') {
        finish(`synthesis failed: ${msg.message}`);
      }
    });
    proc.send({ type: 'init', cacheDir: modelsDir, dtype });
  });
  proc.kill();
  if (result !== 'done') {
    if (log.trim()) console.log(log.trim());
    return fail(`Kokoro: ${result}`);
  }
  checkAudioFile(outFile, 'Kokoro');
}

/** Bundles the TypeScript speech modules on the fly so this script tests the real code. */
async function loadSpeechModules() {
  const esbuild = require('esbuild');
  const bundle = path.join(out, 'speech.cjs');
  await esbuild.build({
    stdin: {
      contents: `export * from './src/tts/systemVoice'; export * from './src/tts/winAudioHost';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
  });
  return require(bundle);
}

async function systemVoice(mod) {
  const voice = mod.systemVoice();
  if (!voice) {
    const msg = 'system voice: none on this machine (Linux needs espeak-ng)';
    return has('--require-system') ? fail(msg) : skip(msg);
  }
  const file = path.join(out, `system.${voice.extension}`);
  try {
    await voice.speakToFile(SENTENCE, file, '', 1);
  } catch (err) {
    const msg = `${voice.label}: ${err.message}`;
    // Windows Server images may ship without any SAPI voice.
    if (process.platform === 'win32' && !has('--require-system') && /voice|SpeechSynthesizer|No voice/i.test(err.message)) {
      return skip(msg);
    }
    return fail(msg);
  }
  checkAudioFile(file, voice.label);
}

async function windowsAudioHost(mod, wav) {
  const events = [];
  let ready = false;
  const host = mod.WinAudioHost.start(
    {
      ended: (id) => events.push(`ended ${id}`),
      error: (id, message) => events.push(`error ${id} ${message}`),
      exit: (code) => events.push(`exit ${code}`),
    },
    (line) => {
      if (line.includes('helper ready')) ready = true;
      else console.log(`      ${line}`);
    },
  );
  if (!host) return fail('Windows audio helper: could not start');
  const wait = async (pred, ms) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return pred();
  };
  if (!(await wait(() => ready || events.some((e) => e.startsWith('exit')), 90_000))) {
    host.dispose();
    return fail('Windows audio helper: no "ready" within 90 s');
  }
  if (!ready) return fail(`Windows audio helper: ${events.join('; ')}`);
  ok('Windows audio helper compiled and started');
  if (wav) {
    host.play(7, wav);
    await wait(() => events.length > 0, 30_000);
    const first = events[0] ?? 'nothing within 30 s';
    if (first === 'ended 7') ok('Windows audio helper played a clip to the end');
    else console.log(`note  Windows audio helper playback: ${first} (expected on CI machines without a sound card)`);
  }
  host.dispose();
}

console.log(`ShowMe speech smoke test on ${process.platform}-${process.arch}, Node ${process.version}`);
if (!has('--skip-kokoro')) await kokoro();
else skip('Kokoro');
const mod = await loadSpeechModules();
if (!has('--skip-system')) await systemVoice(mod);
else skip('system voice');
if (process.platform === 'win32') {
  const wav = [path.join(out, 'kokoro.wav'), path.join(out, 'system.wav')].find((f) => fs.existsSync(f));
  await windowsAudioHost(mod, wav);
}
fs.rmSync(out, { recursive: true, force: true });
console.log(failed ? '\nSMOKE TEST FAILED' : '\nsmoke test passed');
process.exit(failed ? 1 : 0);
