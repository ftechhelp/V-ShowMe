# V-ShowMe

Ask your AI agent to **show** you how something works, not just tell you. ShowMe is an extension for VS Code and Visual Studio, plus an agent skill. The agent opens the right files, highlights the lines it is talking about, and explains them **out loud**, step by step, like a colleague walking you through the code at your desk.

- **Highlight and focus:** the current lines get a highlight and the rest of the file fades out.
- **Captions:** each explanation appears in a bubble right under the code, and in a sidebar with all the steps.
- **Local neural voice:** [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) runs on your machine. It's free and works offline after a one-time download. Your operating system's built-in voice is the fallback.
- **Runs everywhere:** VS Code on macOS, Windows and Linux, and Visual Studio 2022/2026 on Windows (preview).
- **Controls:** pause mid-sentence, skip, go back, replay, or jump to any step.
- **Ask questions mid-tour:** the agent can read which step you're on, so "wait, why is this here?" just works.

## How it works

```
You: "show me how login works"
  → the agent (with the show-me skill) reads the code and writes .showme/tours/<time>-<slug>.json
  → the ShowMe extension (VS Code or Visual Studio) notices the file and plays it: open, highlight, caption, speak, next…
  → the extension writes .showme/status.json, which the agent reads to fix mistakes and to follow along
```

There is no server or MCP setup; the two sides talk through files in your workspace. `.showme/` creates its own `.gitignore`, so nothing there gets committed.

## Getting started

1. Install ShowMe, then run **ShowMe: Install Agent Skill** from the Command Palette. Choose your agent and whether to install the skill personally or in the open project.
2. Ask your agent something like *"show me how the tour player handles pause"*.

To see it without an agent, run **ShowMe: Play Demo Tour**. It walks through ShowMe's own source.

The first time ShowMe speaks, it downloads the Kokoro voice model (about 320 MB, or about 90 MB with `showme.tts.kokoroModel` set to `q8`). Until the download finishes, it narrates with your system's built-in voice. **ShowMe: Test Voice** checks your audio.

For Visual Studio, see [Visual Studio (preview)](#visual-studio-preview).

### Agent skill locations

The installer supports GitHub Copilot, Claude Code, OpenAI Codex, OpenCode, Cursor and Gemini CLI. The **Shared agents directory** option installs once for compatible versions of Copilot, Codex, OpenCode, Cursor and Gemini CLI; Claude Code uses its own directory. The complete skill, including its reference, is copied. Existing installations are replaced only after confirmation.

| Agent | Personal (under your home directory) | Project (under the project root) |
|---|---|---|
| GitHub Copilot | `.copilot/skills/show-me` | `.github/skills/show-me` |
| Claude Code | `.claude/skills/show-me` | `.claude/skills/show-me` |
| OpenAI Codex / shared | `.agents/skills/show-me` | `.agents/skills/show-me` |
| OpenCode | `.config/opencode/skills/show-me` | `.opencode/skills/show-me` |
| Cursor | `.cursor/skills/show-me` | `.cursor/skills/show-me` |
| Gemini CLI | `.gemini/skills/show-me` | `.gemini/skills/show-me` |

Project installations can be committed and shared with a team; personal installations stay on the machine where the extension runs. In VS Code, choose the workspace folder when more than one is open; in Visual Studio, the project location is the repository root, or the solution/open folder if it is not in a repository. For remote development, install where the agent runs. Restart the agent or start a new session if it does not immediately discover the skill. Avoid installing multiple copies in locations the same agent scans: duplicate skills may appear.

You can also install manually without an extension: copy the entire [`skill/show-me`](skill/show-me/) directory to one of the locations above, keeping `SKILL.md` and `reference/` together. For other harnesses that support the Agent Skills format, use their documented skills directory.

## Controls

| Action | Keys | Also |
|---|---|---|
| Pause / resume | `Ctrl+Alt+Space` | Sidebar button or status bar item |
| Next / previous step | `Ctrl+Alt+→` / `Ctrl+Alt+←` (Linux: `Ctrl+Alt+.` / `Ctrl+Alt+,`, because desktops use the arrows to switch workspaces) | Sidebar buttons |
| Jump to a step | | Click it in the sidebar |
| Replay a saved tour | | **ShowMe: Play Tour…** |

## Settings

| Setting | Default | |
|---|---|---|
| `showme.tts.engine` | `kokoro` | `kokoro`, `system` (the OS voice), or `none` (captions only). `macos` still works as an old name for `system`. |
| `showme.tts.kokoroVoice` | `af_heart` | American/British, female/male voices |
| `showme.tts.kokoroModel` | `fp32` | `fp32`: ~320 MB, ~4× real-time. `q8`: ~90 MB, ~2× real-time. |
| `showme.tts.systemVoice` | system default | macOS: e.g. `Zoe (Premium)` (download better voices in System Settings → Accessibility → Spoken Content). Windows: e.g. `Microsoft Zira Desktop`. Linux: an eSpeak NG voice such as `en-us`. Replaces `showme.tts.macosVoice`. |
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

## Platforms

| | VS Code | Visual Studio |
|---|---|---|
| **macOS** (Apple Silicon, Intel) | ✓ | (Visual Studio for Mac was retired) |
| **Windows** (x64, ARM64) | ✓ | ✓ 2022 17.10+ and 2026, preview |
| **Linux** (x64, arm64) | ✓ | |

Each VS Code platform gets its own VSIX with only its own native Kokoro binaries.

| | Fallback voice | Audio playback |
|---|---|---|
| macOS | `say` | `afplay` |
| Windows | Windows (SAPI) voices | A small PowerShell helper using the Windows media API, with real pause. If it can't start, it falls back to playing each sentence separately, and pause restarts the sentence. |
| Linux | `espeak-ng` (install it: `sudo apt install espeak-ng`) | `pw-play`, `paplay` or `aplay` (PipeWire, `pulseaudio-utils` or `alsa-utils`) |

Without a fallback voice, ShowMe shows captions until Kokoro is ready. Without any audio player, it shows captions only.

**Remote development (WSL, SSH, containers):** ShowMe runs where your workspace is, so it speaks through the remote machine's audio. On Windows 11 with WSL, install `pulseaudio-utils` in your distribution and audio plays through WSLg.

## Visual Studio (preview)

Install `ShowMe.VisualStudio.vsix` (see [Development](#development)), then open a solution or folder. ShowMe watches `.showme/tours/` in the solution folder and in every folder above it up to the repository root, where agents often run.

- **Tools → ShowMe** has the commands, including **Install Agent Skill**. **View → Other Windows → ShowMe Walkthrough** shows the steps.
- **Keys:** `Ctrl+Alt+Space` is taken in Visual Studio, so use `Ctrl+Shift+Alt+Space` to pause or resume and `Ctrl+Shift+Alt+.` / `Ctrl+Shift+Alt+,` to step.
- **Settings:** Tools → Options → ShowMe, with the same options as in VS Code.
- **Voice:** the first time, ShowMe downloads a Kokoro helper (about 110 MB, from this repository's GitHub releases, verified by SHA-256) plus the model (about 325 MB, or 165 MB with the small model). Until then it speaks with the Windows voice.

The Visual Studio version is built and unit-tested in CI, but nobody has tried its editor UI (highlight, fading, caption bubble) on a real Windows machine yet. Please report what you see.

## Notes

- In VS Code, Kokoro runs in a child process using VS Code's own Node runtime (the "Code Helper (Plugin)" binary on macOS), so no system Node is needed at runtime.
- The model downloads from Hugging Face into the extension's global storage on first use. Narration audio is cached for 14 days.

## Development

Requires Node 22.

```bash
npm install          # on Linux x64: ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install (otherwise it fetches the CUDA build)
npm run build        # or: npm run watch
npm test             # unit tests (schema, anchors, speech text, queue, player, platform audio, shared spec, demo tour)
```

- **Run from source:** press **F5** in VS Code ("Run ShowMe"), then run **ShowMe: Play Demo Tour** in the new window. From source, personal skill installations are symlinked; project installations are copied so they can be shared.
- **Package:** `npm run package` builds one `.vsix` per platform into `vsix/`. `npm run package -- win32-x64` builds just one. Install it with **Extensions → … → Install from VSIX**.
- **Speech smoke test:** `node scripts/smoke-voice.mjs --extension <unzipped VSIX>/extension --models <dir>` runs Kokoro and the system voice the way CI does on each OS.

### Visual Studio

Requires the .NET 10 SDK. The core library, its tests and the Kokoro helper build anywhere. The VSIX itself builds only on Windows (`msbuild /restore`), and CI does that on every push.

```bash
dotnet test visualstudio/test/ShowMe.Core.Tests          # shared spec vectors, player, queue, status.json
dotnet build visualstudio/src/ShowMe.VisualStudio        # compile check (VSIX packaging needs Windows)
dotnet publish visualstudio/src/ShowMe.KokoroHost -c Release -r osx-arm64 --self-contained -o visualstudio/artifacts/host
node visualstudio/scripts/smoke-kokoro-host.mjs visualstudio/artifacts/host visualstudio/artifacts/models q8
```

- **The VSIX:** download the `visualstudio-vsix` artifact from a CI run.
- **The Kokoro helper** is published by the **Kokoro helper release** workflow (Actions → Run workflow). Copy the SHA-256 values from its summary into `visualstudio/src/ShowMe.VisualStudio/kokoro-host.json`. To test a local build, set `SHOWME_KOKORO_HOST` to its `ShowMe.KokoroHost.exe`.
- **Shared behaviour:** `spec/*.json` holds test vectors that both the TypeScript and the C# code must pass. After an intended behaviour change, run `node scripts/update-spec.mjs`, review the diff, and update the C# port to match.

### Code map

| Path | What |
|---|---|
| `src/extension.ts` | Activation and wiring of commands |
| `src/controller.ts` | Loads a tour and connects the player, editor, voice, sidebar and `status.json` |
| `src/player/player.ts` | Playback state machine (pure and unit-tested) |
| `src/editor/presenter.ts` | Highlight, dimming, scrolling, caption bubble (Comments API) |
| `src/tour/` | Schema/validation, anchor resolution, watcher, status file |
| `src/tts/` | Speech text normalization, synthesis queue, Kokoro worker process, system voices, audio playback (incl. the Windows audio helper) |
| `src/ui/` | Sidebar webview and status bar |
| `skill/show-me/` | The agent skill (`SKILL.md` and the format reference) |
| `examples/demo.tour.json` | Tour of this codebase (a test keeps its line numbers in sync) |
| `scripts/` | Per-platform packaging, speech smoke test, spec regeneration |
| `spec/` | Behaviour vectors shared by the TypeScript and C# implementations |
| `visualstudio/src/ShowMe.Core` | C# port of the tour format, anchors, speech text, queue, player and `status.json` |
| `visualstudio/src/ShowMe.VisualStudio` | The Visual Studio extension: package, commands, editor adornments, walkthrough window, voice |
| `visualstudio/src/ShowMe.KokoroHost` | Kokoro helper process for Visual Studio (KokoroSharp) |
