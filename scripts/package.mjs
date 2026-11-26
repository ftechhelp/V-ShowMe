#!/usr/bin/env node
/**
 * Builds one platform-specific VSIX per target into vsix/. Each VSIX carries only its own
 * onnxruntime-node binaries (about 35 MB each), so it stays small.
 *
 *   npm run package                      all targets
 *   npm run package -- win32-x64 ...     only these
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vsix');
const ORT = 'node_modules/onnxruntime-node/bin/napi-v3';

export const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];

const requested = process.argv.slice(2);
const unknown = requested.filter((t) => !TARGETS.includes(t));
if (unknown.length) {
  console.error(`Unknown target(s): ${unknown.join(', ')}. Valid: ${TARGETS.join(', ')}`);
  process.exit(1);
}
const targets = requested.length ? requested : TARGETS;

const { version, name } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const baseIgnore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showme-package-'));
// Run vsce's JS entry with this Node, so no shell (and no path quoting) is involved on Windows.
const vsce = path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');

try {
  for (const target of targets) {
    const [osName, arch] = target.split('-');
    const keep = path.join(ROOT, ORT, osName, arch);
    if (!fs.existsSync(keep)) throw new Error(`missing ${path.relative(ROOT, keep)}; run npm install`);
    // On Linux x64, onnxruntime-node's install script swaps in its CUDA build (hundreds of MB)
    // unless told not to. Kokoro runs on the CPU, so refuse to ship that.
    if (fs.readdirSync(keep).some((f) => f.includes('providers_cuda') || f.includes('providers_tensorrt'))) {
      throw new Error(
        `${path.relative(ROOT, keep)} contains the CUDA build of onnxruntime. Reinstall with ` +
          '`ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci` before packaging.',
      );
    }

    const others = TARGETS.filter((t) => t !== target).map((t) => `${ORT}/${t.replace('-', '/')}/**`);
    const ignoreFile = path.join(tmp, `${target}.vscodeignore`);
    fs.writeFileSync(ignoreFile, `${baseIgnore}\n# added by scripts/package.mjs for ${target}\n${others.join('\n')}\n`);

    const out = path.join(OUT, `${name}-${target}-${version}.vsix`);
    console.log(`\n=== ${target} ===`);
    execFileSync(process.execPath, [vsce, 'package', '--target', target, '--ignoreFile', ignoreFile, '--out', out], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log(`${path.relative(ROOT, out)}: ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
