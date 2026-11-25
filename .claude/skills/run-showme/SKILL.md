---
name: run-showme
description: Launch and drive the ShowMe VS Code extension end to end in an isolated VS Code instance. Plays tours, presses keys, clicks the sidebar, takes screenshots, and reads status.json and logs. Use when asked to run, test, screenshot or verify ShowMe in a real VS Code, or to check that a change to the extension works in the app rather than just in unit tests.
---

# Run ShowMe (isolated VS Code + CDP driver)

ShowMe is a VS Code extension, so the "app" is VS Code itself. The driver, `.claude/skills/run-showme/driver.mjs`, starts a **separate VS Code instance** with its own profile in `.e2e/ud` and its own extensions in `.e2e/ext`, and loads this repo as a development extension. It drives that instance over the Chrome DevTools Protocol on port 9333. The user's own VS Code is never touched.

All commands run from the repo root. Each command is one-shot, so you don't need tmux or a REPL.

```bash
npm run e2e -- launch --engine none     # builds, launches, waits until ShowMe has activated
npm run e2e -- tour                     # writes fixtures/cart.tour.json into the workspace, prints status.json
npm run e2e -- shot step1               # .e2e/shots/step1.png; then Read the PNG and look at it
npm run e2e -- key Control+Alt+Space    # pause
npm run e2e -- status
npm run e2e -- stop
```

**Before launching with sound, tell the user.** `--engine kokoro` (the default) and `--engine macos` speak **out loud** through their speakers. Use `--engine none` (captions only, steps advance by reading time) for silent runs. With Kokoro, the driver reuses the model that the user's installed ShowMe already downloaded. `--fresh-model` starts with an empty model folder to test the first-run download plus macOS fallback (about 320 MB, or about 90 MB with q8).

## Prerequisites

- macOS with VS Code at `/Applications/Visual Studio Code.app`. Override the binary with `VSCODE_BIN`.
- `npm install`. This provides `playwright-core`, which is only used to attach over CDP; no browsers are downloaded.

## Commands

| Command | What it does |
|---|---|
| `launch [--engine kokoro\|macos\|none] [--workspace <dir>] [--fresh-model] [--no-build]` | Runs `npm run build`, copies `fixtures/sample-ws` to `.e2e/ws` (unless `--workspace`), launches, waits for `[showme] activated` |
| `stop` | Kills **only** the instance we launched (checks its `--user-data-dir`) |
| `tour [file.json]` | Copies a tour into `<ws>/.showme/tours/` the way an agent would, waits 2.5 s, prints status. The default is `fixtures/cart.tour.json`; also try `fixtures/broken.tour.json` |
| `status` | Summary of `<ws>/.showme/status.json`: state, step, `lines` vs `shownLines`, issues |
| `log [n]` | Tail of the ShowMe output channel (engine choice, Kokoro worker, warnings) |
| `shot [name]` | Screenshot of the window to `.e2e/shots/<name>.png` |
| `key <combo>` | Playwright key combo: `Control+Alt+Space` (pause/resume), `Control+Alt+ArrowRight` / `ArrowLeft` |
| `run <command title>` | Command Palette, e.g. `run ShowMe: Play Demo Tour` |
| `click <css>` | Clicks in the sidebar webview: `'button[data-cmd="stop"]'`, `togglePause`, `next`, `previous`, `replay`, or `'li[data-goto="1"]'` (0-based step) |
| `text` | The sidebar's visible text |
| `sidebar <js>` | Evaluate in the sidebar; `doc` is its document |
| `editor` | `{visibleLines, dimmedLines, captionBubbles, activeTab}`, which are hard to judge from a screenshot |
| `wait <css>` / `eval <js>` | Workbench DOM helpers |

## A typical verification

1. `launch --engine none`
2. `tour`. Expect `state: playing` and step 1 at `src/cart.js`. Step 2 has stale lines on purpose: `lines=[16,19]` should come back as `shown=[18,21]`.
3. `shot step1`, then Read the PNG. You should see the yellow highlight, faded other lines, the caption bubble under the code, and the sidebar with steps.
4. `editor`. Expect `dimmedLines > 0` and `captionBubbles: 1`.
5. `key Control+Alt+Space`, then `status`. Expect `paused` and no progress after a few seconds.
6. `click 'li[data-goto="2"]'`, then `click 'button[data-cmd="stop"]'`, then `status` → `stopped`; `editor` → no dimming, no bubble.
7. `tour .claude/skills/run-showme/fixtures/broken.tour.json`. Expect an error for the missing file, a warning for the bad anchor, and an error for the step without narration.
8. `stop`

## Gotchas (all hit while building this)

- **Socket path limit.** VS Code creates an IPC socket inside `--user-data-dir`, and macOS caps socket paths at 103 characters. A deep path fails with `listen EINVAL`. The driver checks for this; set `SHOWME_E2E_DIR` to a shorter path if needed.
- **Never kill VS Code by a broad pattern.** The user's own VS Code runs alongside. `stop` only kills the PID whose command line contains our user-data-dir.
- **The sidebar is an out-of-process webview iframe.** Playwright's `page.frames()` can't reach it. The driver attaches to the webview's own CDP target (`/json/list`, type `iframe`) and evaluates in the inner `iframe.contentDocument`. Click via DOM `.click()`, not coordinates.
- **Kokoro only loads inside "Code Helper (Plugin)".** The main `Code` binary refuses onnxruntime's native module (macOS library validation, "different Team IDs"). The extension host already runs in the plugin helper. To debug the worker by hand, use `ELECTRON_RUN_AS_NODE=1 ".../Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)" script.js`.
- **Layout persists between launches** in `.e2e/ud`. The bottom panel or the last sidebar view may reappear from the previous run. Delete `.e2e/ud` for a pristine profile.
- **A tour written while VS Code is still starting** used to be missed. The extension now replays any tour from the last 30 s when it activates. `tour` waits for activation anyway.

## Human path

Press F5 in VS Code ("Run ShowMe"), then run **ShowMe: Play Demo Tour** in the new window.
