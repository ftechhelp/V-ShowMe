# ShowMe

Ask your AI agent to **show** you how something works, not just tell you. ShowMe is a VS Code extension plus an agent skill. The agent opens the right files, highlights the lines it is talking about, and explains them **out loud**, step by step, like a colleague walking you through the code at your desk.

- **Highlight and focus:** the current lines get a highlight and the rest of the file fades out.
- **Captions:** each explanation appears in a bubble right under the code, and in a sidebar with all the steps.
- **Local neural voice:** [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) runs on your machine. It's free and works offline after a one-time download. The built-in macOS voice is the fallback.
- **Controls:** pause mid-sentence, skip, go back, replay, or jump to any step.
- **Ask questions mid-tour:** the agent can read which step you're on, so "wait, why is this here?" just works.

## How it works

```
You: "show me how login works"
  → the agent (with the show-me skill) reads the code and writes .showme/tours/<time>-<slug>.json
  → the ShowMe extension notices the file and plays it: open, highlight, caption, speak, next…
  → the extension writes .showme/status.json, which the agent reads to fix mistakes and to follow along
```

There is no server or MCP setup; the two sides talk through files in your workspace. `.showme/` creates its own `.gitignore`, so nothing there gets committed.

## Setup

Prerequisite for development: Node 22. On this machine it is installed keg-only by Homebrew at `/opt/homebrew/opt/node@22/bin`.

```bash
npm install
npm run build        # or: npm run watch
npm test             # unit tests (schema, anchors, speech text, queue, player, demo tour)
```

- **Try it:** press **F5** in VS Code ("Run ShowMe"), then run **ShowMe: Play Demo Tour** in the new window. It walks through ShowMe's own source.
- **Install the skill:** run **ShowMe: Install Agent Skill (Claude Code)**. This copies `skill/show-me` to `~/.claude/skills/show-me`, or symlinks it when you run from source.
- **Package:** `npm run package` builds a `.vsix`. Install it with **Extensions → … → Install from VSIX**.

Then ask Claude Code something like *"show me how the tour player handles pause"*.

## Controls

| Action | Keys | Also |
|---|---|---|
| Pause / resume | `Ctrl+Alt+Space` | Sidebar button or status bar item |
| Next / previous step | `Ctrl+Alt+→` / `Ctrl+Alt+←` | Sidebar buttons |
| Jump to a step | | Click it in the sidebar |
| Replay a saved tour | | **ShowMe: Play Tour…** |

## Settings

| Setting | Default | |
|---|---|---|
| `showme.tts.engine` | `kokoro` | `kokoro`, `macos`, or `none` (captions only) |
| `showme.tts.kokoroVoice` | `af_heart` | American/British, female/male voices |
| `showme.tts.kokoroModel` | `fp32` | `fp32`: ~320 MB, ~4× real-time. `q8`: ~90 MB, ~2× real-time. |
| `showme.tts.macosVoice` | system | E.g. `Zoe (Premium)`. Download better voices in System Settings → Accessibility → Spoken Content. |
| `showme.tts.speed` | `1` | |
| `showme.autoAdvance` | `true` | Off: wait for Next after each step |
| `showme.pauseBetweenSteps` | `600` | ms |
| `showme.dimOtherLines` | `true` | |
| `showme.inlineCaptions` | `true` | |
| `showme.autoPlayNewTours` | `true` | |

ShowMe also sets the default of `comments.openView` to `never`. Otherwise VS Code opens the Comments panel the first time a caption bubble appears. You can override it in your settings.

## Tour format

See [skill/show-me/reference/tour-format.md](skill/show-me/reference/tour-format.md). In short:

```json
{
  "title": "How login works",
  "steps": [
    { "title": "The route", "file": "src/routes/auth.ts", "lines": [14, 22],
      "anchor": "router.post('/login', async (req, res) => {",
      "narration": "Everything starts at this route…" },
    { "title": "Recap", "narration": "So, to recap…" }
  ]
}
```

`anchor` is the text of the first highlighted line. If the code has moved since the agent read it, ShowMe finds the nearest match and shifts the highlight.

## Code map

| Path | What |
|---|---|
| `src/extension.ts` | Activation and wiring of commands |
| `src/controller.ts` | Loads a tour and connects the player, editor, voice, sidebar and `status.json` |
| `src/player/player.ts` | Playback state machine (pure and unit-tested) |
| `src/editor/presenter.ts` | Highlight, dimming, scrolling, caption bubble (Comments API) |
| `src/tour/` | Schema/validation, anchor resolution, watcher, status file |
| `src/tts/` | Speech text normalization, synthesis queue, Kokoro worker process, macOS `say`, audio playback |
| `src/ui/` | Sidebar webview and status bar |
| `skill/show-me/` | The agent skill (`SKILL.md` and the format reference) |
| `examples/demo.tour.json` | Tour of this codebase (a test keeps its line numbers in sync) |

## Notes

- Kokoro runs in a child process using VS Code's own Node runtime (the "Code Helper (Plugin)" binary), so no system Node is needed at runtime.
- The model downloads from Hugging Face into the extension's global storage on first use. Narration audio is cached for 14 days.
- Platform support: macOS is the main target. Linux plays audio with `paplay`/`aplay`. Windows plays audio, but pause restarts the current sentence.
