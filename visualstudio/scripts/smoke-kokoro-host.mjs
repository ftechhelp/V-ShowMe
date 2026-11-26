#!/usr/bin/env node
/**
 * Smoke test for the Visual Studio Kokoro helper (ShowMe.KokoroHost): starts the published exe,
 * loads (or downloads) the model, synthesizes one sentence and checks the WAV.
 *
 *   node visualstudio/scripts/smoke-kokoro-host.mjs <publish dir> <models dir> [q8|fp32]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const [dir, models, dtype = 'q8'] = process.argv.slice(2);
if (!dir || !models) {
  console.error('usage: smoke-kokoro-host.mjs <publish dir> <models dir> [q8|fp32]');
  process.exit(2);
}
const exe = path.join(path.resolve(dir), process.platform === 'win32' ? 'ShowMe.KokoroHost.exe' : 'ShowMe.KokoroHost');
const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'showme-host-')), 'clip.wav');
console.log(`host ${exe}\nmodels ${models} (${dtype})`);

const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');
let lastPct = -10;

const result = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timed out after 15 minutes'), 15 * 60_000);
  const finish = (r) => {
    clearTimeout(timer);
    resolve(r);
  };
  proc.on('exit', (code) => finish(`host exited with code ${code}`));
  proc.on('error', (err) => finish(`could not start: ${err.message}`));
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return finish(`non-protocol output on stdout: ${line}`);
    }
    if (msg.type === 'progress') {
      const pct = Math.floor((msg.loaded / msg.total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        console.log(`  downloading ${msg.file}: ${pct}%`);
      }
    } else if (msg.type === 'ready') {
      console.log(`  model ready in ${msg.loadMs} ms`);
      send({ type: 'synth', id: 1, text: 'Here we check that the ShowMe narrator can speak in Visual Studio.', voice: 'af_heart', speed: 1, outFile });
    } else if (msg.type === 'initFailed') {
      finish(`init failed: ${msg.message}`);
    } else if (msg.type === 'done') {
      console.log(`  synthesized in ${msg.ms} ms`);
      finish('done');
    } else if (msg.type === 'failed') {
      finish(`synthesis failed: ${msg.message}`);
    }
  });
  send({ type: 'init', cacheDir: path.resolve(models), dtype });
});
proc.stdin.end();
proc.kill();

if (result !== 'done') {
  console.log(`FAIL  ${result}`);
  process.exit(1);
}
const bytes = fs.readFileSync(outFile);
const ok = bytes.length > 10_000 && bytes.subarray(0, 4).toString('latin1') === 'RIFF';
console.log(`${ok ? 'ok   ' : 'FAIL '} ${outFile}: ${(bytes.length / 1024).toFixed(0)} KB`);
process.exit(ok ? 0 : 1);
