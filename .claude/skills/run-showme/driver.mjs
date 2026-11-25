#!/usr/bin/env node
// ShowMe e2e driver.
//
// Launches an ISOLATED VS Code instance (its own profile and extensions dir, so the user's VS Code is
// never touched) with this repo loaded as a development extension, then drives it over the Chrome
// DevTools Protocol. Each command is one-shot and reconnects; state lives in <repo>/.e2e/.
//
//   node .claude/skills/run-showme/driver.mjs help
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SKILL_DIR, '../../..');
const E2E = path.resolve(process.env.SHOWME_E2E_DIR || path.join(REPO, '.e2e'));
const UD = path.join(E2E, 'ud'); // VS Code user-data-dir (must stay short, see checkSocketPath)
const EXT = path.join(E2E, 'ext');
const SHOTS = path.join(E2E, 'shots');
const SAMPLE_WS = path.join(E2E, 'ws');
const STATE = path.join(E2E, 'state.json');
const PORT = Number(process.env.SHOWME_E2E_PORT || 9333);
const CODE_BIN = process.env.VSCODE_BIN || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const STORAGE = path.join(UD, 'User', 'globalStorage', 'v-showme.showme');
const REAL_MODELS = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/v-showme.showme/models');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : undefined);

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function bool(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

/** True if `pid` is the isolated VS Code we launched (never touch the user's own instance). */
function isOurs(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes(`--user-data-dir=${UD}`);
  } catch {
    return false;
  }
}

function checkSocketPath() {
  // VS Code puts an IPC socket in the user-data-dir; macOS limits socket paths to 103 chars.
  const sock = path.join(UD, '1.999-main.sock');
  if (sock.length > 100) {
    throw new Error(`user-data-dir path too long for VS Code's IPC socket (${sock.length} chars). Set SHOWME_E2E_DIR to a shorter directory.`);
  }
}

async function connect() {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error(`cannot connect to VS Code on port ${PORT}. Is it running? (driver.mjs launch)`);
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('VS Code workbench page not found');
  return { browser, page };
}

async function withPage(fn) {
  const { browser, page } = await connect();
  try {
    return await fn(page);
  } finally {
    await browser.close(); // for CDP connections this only disconnects
  }
}

/** Evaluates `expr` inside the ShowMe sidebar webview; `doc` is the webview's content document. */
async function inSidebar(expr) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const webviews = targets.filter((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://'));
  const t = webviews.find((w) => /extensionId=v-showme\.showme/.test(w.url)) ?? webviews[0];
  if (!t) throw new Error('ShowMe sidebar webview not found. Open it first (click the ShowMe activity bar icon, or play a tour).');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const expression = `(() => { const doc = document.querySelector('iframe')?.contentDocument ?? document; return (${expr}); })()`;
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  const result = await new Promise((resolve) =>
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) resolve(msg.result?.exceptionDetails?.exception?.description ?? msg.result?.result?.value);
    }),
  );
  ws.close();
  return result;
}

function workspace() {
  const s = readState();
  if (!s) throw new Error('not launched (driver.mjs launch)');
  return s.workspace;
}

function showmeLog() {
  const logs = path.join(UD, 'logs');
  if (!fs.existsSync(logs)) return undefined;
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/ShowMe\.log$/.test(e.name)) found.push(p);
    }
  };
  walk(logs);
  return found.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).pop();
}

function printStatus() {
  const file = path.join(workspace(), '.showme', 'status.json');
  if (!fs.existsSync(file)) return console.log('no status.json yet');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const step = s.currentStep;
  console.log(`state: ${s.state}   tour: ${s.tour?.title ?? '-'} (${s.tour?.file ?? '-'})`);
  if (step) console.log(`step ${step.number}/${s.tour.totalSteps}: ${step.title ?? ''}  ${step.file ?? '(no file)'} lines=${JSON.stringify(step.lines)} shown=${JSON.stringify(step.shownLines)}`);
  for (const i of s.issues ?? []) console.log(`  ${i.severity}${i.step ? ` (step ${i.step})` : ''}: ${i.message}`);
  console.log(`updated ${s.updatedAt}`);
}

const COMMANDS = {
  async launch(args) {
    const s = readState();
    if (s && isOurs(s.pid)) return console.log(`already running (pid ${s.pid}), workspace ${s.workspace}`);
    checkSocketPath();

    const engine = flag(args, '--engine', 'kokoro');
    const custom = flag(args, '--workspace', undefined);
    const freshModel = bool(args, '--fresh-model');
    const skipBuild = bool(args, '--no-build');

    if (!skipBuild) execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });

    fs.mkdirSync(path.join(UD, 'User'), { recursive: true });
    fs.mkdirSync(EXT, { recursive: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(
      path.join(UD, 'User', 'settings.json'),
      JSON.stringify(
        {
          'workbench.startupEditor': 'none',
          'workbench.tips.enabled': false,
          'security.workspace.trust.enabled': false,
          'telemetry.telemetryLevel': 'off',
          'update.mode': 'none',
          'extensions.autoCheckUpdates': false,
          'window.restoreWindows': 'none',
          'chat.disableAIFeatures': true,
          'showme.tts.engine': engine,
        },
        null,
        2,
      ),
    );

    // Voice model: reuse the one the installed extension already downloaded, unless testing first run.
    const models = path.join(STORAGE, 'models');
    fs.rmSync(models, { recursive: true, force: true });
    if (freshModel || !fs.existsSync(REAL_MODELS)) fs.mkdirSync(models);
    else fs.symlinkSync(REAL_MODELS, models, 'dir');

    let ws = custom ? path.resolve(custom) : SAMPLE_WS;
    if (!custom) {
      fs.rmSync(SAMPLE_WS, { recursive: true, force: true });
      fs.cpSync(path.join(SKILL_DIR, 'fixtures', 'sample-ws'), SAMPLE_WS, { recursive: true });
    }

    const out = fs.openSync(path.join(E2E, 'code.log'), 'w');
    const child = spawn(
      CODE_BIN,
      [
        `--user-data-dir=${UD}`,
        `--extensions-dir=${EXT}`,
        `--extensionDevelopmentPath=${REPO}`,
        `--remote-debugging-port=${PORT}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--new-window',
        ws,
      ],
      { detached: true, stdio: ['ignore', out, out] },
    );
    child.unref();
    fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, workspace: ws, engine, launchedAt: new Date().toISOString() }, null, 2));

    await withPage((page) => page.waitForSelector('.monaco-workbench .statusbar', { timeout: 60_000 }));
    for (let i = 0; i < 60; i++) {
      const log = showmeLog();
      if (log && fs.readFileSync(log, 'utf8').includes('[showme] activated')) {
        console.log(`launched (pid ${child.pid}, voice engine ${engine}${freshModel ? ', fresh model' : ''})`);
        console.log(`workspace: ${ws}`);
        console.log(`ShowMe log: ${log}`);
        return;
      }
      await sleep(500);
    }
    throw new Error(`VS Code started but ShowMe did not activate. See ${path.join(E2E, 'code.log')}`);
  },

  async stop() {
    const s = readState();
    if (!s) return console.log('not running');
    if (isOurs(s.pid)) {
      process.kill(s.pid);
      for (let i = 0; i < 20 && isOurs(s.pid); i++) await sleep(250);
      console.log(isOurs(s.pid) ? `pid ${s.pid} still running` : 'stopped');
    } else {
      console.log('not running (stale state cleared)');
    }
    fs.rmSync(STATE, { force: true });
  },

  /** Copies a tour into the workspace's .showme/tours (this is what an agent does), then reports status. */
  async tour(args) {
    const src = args[0] ? path.resolve(args[0]) : path.join(SKILL_DIR, 'fixtures', 'cart.tour.json');
    const dir = path.join(workspace(), '.showme', 'tours');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dest = path.join(dir, `${stamp}-${path.basename(src).replace(/\.tour\.json$|\.json$/, '')}.json`);
    fs.copyFileSync(src, dest);
    console.log(`wrote ${path.relative(workspace(), dest)}`);
    await sleep(2500);
    printStatus();
  },

  status() {
    printStatus();
  },

  log(args) {
    const log = showmeLog();
    if (!log) return console.log('no ShowMe log yet');
    const lines = fs.readFileSync(log, 'utf8').trimEnd().split('\n');
    console.log(lines.slice(-Number(args[0] || 20)).join('\n'));
  },

  async shot(args) {
    const name = args[0] || `shot-${Date.now()}`;
    const file = path.join(SHOTS, `${name}.png`);
    await withPage((page) => page.screenshot({ path: file }));
    console.log(`screenshot: ${file}`);
  },

  async key(args) {
    await withPage((page) => page.keyboard.press(args[0]));
    console.log(`pressed ${args[0]}`);
  },

  /** Runs a command from the Command Palette by its title, e.g. "ShowMe: Play Demo Tour". */
  async run(args) {
    const title = args.join(' ');
    await withPage(async (page) => {
      await page.keyboard.press('F1');
      const input = await page.waitForSelector('.quick-input-widget input', { timeout: 5000 });
      await input.fill(`>${title}`);
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
    });
    console.log(`ran "${title}"`);
  },

  async wait(args) {
    await withPage((page) => page.waitForSelector(args[0], { timeout: 15_000 }));
    console.log(`found ${args[0]}`);
  },

  async eval(args) {
    console.log(JSON.stringify(await withPage((page) => page.evaluate(args.join(' ')))));
  },

  /** Evaluates JS in the sidebar webview (`doc` = its document). */
  async sidebar(args) {
    console.log(JSON.stringify(await inSidebar(args.join(' '))));
  },

  /** Clicks an element in the sidebar, e.g. 'button[data-cmd="stop"]' or 'li[data-goto="2"]' (0-based). */
  async click(args) {
    const sel = args.join(' ');
    console.log(await inSidebar(`(() => { const el = doc.querySelector(${JSON.stringify(sel)}); if (!el) return 'NOT_FOUND ${sel.replace(/'/g, '')}'; el.click(); return 'clicked'; })()`));
  },

  /** Prints the sidebar's visible text. */
  async text() {
    console.log(await inSidebar(`doc.getElementById('app')?.innerText`));
  },

  /** Editor facts that are hard to see in a screenshot: dimmed lines, caption bubbles. */
  async editor() {
    const r = await withPage((page) =>
      page.evaluate(() => {
        const lines = [...document.querySelectorAll('.editor-instance .view-lines .view-line')];
        const dimmed = lines.filter((l) => [...l.querySelectorAll('span')].some((s) => Number(getComputedStyle(s).opacity) < 1)).length;
        return {
          visibleLines: lines.length,
          dimmedLines: dimmed,
          captionBubbles: document.querySelectorAll('.review-widget').length,
          activeTab: document.querySelector('.tab.active')?.textContent?.trim(),
        };
      }),
    );
    console.log(JSON.stringify(r));
  },

  help() {
    console.log(`ShowMe e2e driver. Commands:
  launch [--engine kokoro|macos|none] [--workspace <dir>] [--fresh-model] [--no-build]
  stop                       close the isolated VS Code
  tour [file.json]           write a tour into the workspace (default: fixtures/cart.tour.json), print status
  status                     summary of .showme/status.json
  log [n]                    last n lines of the ShowMe output channel
  shot [name]                screenshot -> ${path.relative(REPO, SHOTS)}/<name>.png
  key <combo>                e.g. Control+Alt+Space, Control+Alt+ArrowRight
  run <command title>        Command Palette, e.g. run ShowMe: Play Demo Tour
  click <css>                click in the sidebar, e.g. 'button[data-cmd="stop"]', 'li[data-goto="1"]'
  text                       sidebar text
  sidebar <js>               evaluate in the sidebar (doc = its document)
  editor                     dimmed lines / caption bubbles / active tab
  wait <css> | eval <js>     workbench DOM helpers`);
  },
};

const [cmd = 'help', ...rest] = process.argv.slice(2);
const fn = COMMANDS[cmd];
if (!fn) {
  console.error(`unknown command: ${cmd}`);
  COMMANDS.help();
  process.exit(1);
}
try {
  await fn(rest);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
