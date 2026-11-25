# ShowMe tour format (version 1)

## Files

```
<workspace>/.showme/
  .gitignore          created by the extension ("*"), so nothing here gets committed
  tours/<name>.json   written by you, the agent; each new or rewritten file starts playing
  status.json         written by the extension; read it, never edit it
```

## Tour file

```jsonc
{
  "version": 1,                       // optional, always 1 for now
  "title": "How login works",         // shown in the sidebar
  "steps": [ /* 1 or more steps */ ]
}
```

### Step fields

| Field | Required | Meaning |
|---|---|---|
| `narration` | yes | What is said and shown as the caption. Light Markdown: `code`, **bold**, *italic*. Write it for the ear. |
| `title` | no, but recommended | A short label (2–5 words) for the step list. |
| `file` | no | Path relative to the workspace root, with forward slashes. Leave it out for intro or recap steps that need no code. |
| `lines` | no | `[start, end]` (1-based, inclusive) or a single number. Requires `file`. Without `lines`, the file opens at the top with no highlight. |
| `anchor` | no, but strongly recommended | The exact text of the first highlighted line (trimmed; a distinctive part is fine). If the code moved, the range is shifted to the occurrence nearest the original line. |

Steps without `narration` are skipped. Invalid `lines` keep the step but drop the highlight. Both cases are reported in `status.json` as `issues`.

### Behaviour during playback

- Steps play in order. After each one finishes speaking there is a short pause (600 ms by default), then the next step starts.
- Consecutive steps in the same file just move the highlight. This works well for going through a long function in parts.
- A step without `file` keeps the previous editor on screen and removes the highlight.

## status.json (read-only for agents)

```jsonc
{
  "about": "Written by the ShowMe VS Code extension…",
  "updatedAt": "2026-11-24T15:30:14.120Z",
  "state": "playing",            // loading | playing | paused | waiting | finished | stopped | error | idle
  "tour": { "file": ".showme/tours/20261124-153012-login-flow.json", "title": "How login works", "totalSteps": 8 },
  "currentStep": {               // null when nothing is on screen
    "number": 3,                 // 1-based
    "title": "Password check",
    "file": "src/auth/login.ts",
    "lines": [40, 52],           // as written in the tour
    "shownLines": [42, 54],      // what is actually highlighted after anchor resolution
    "narration": "…"
  },
  "issues": [                    // problems found when loading or showing the tour
    { "step": 5, "severity": "warning", "message": "Anchor \"…\" not found in file; using lines 80-91 as given." },
    { "step": 6, "severity": "error", "message": "File not found: src/auth/tokens.ts" }
  ]
}
```

States:
- `paused`: the user paused, probably to look closer or to ask you something.
- `waiting`: auto-advance is off, so the step finished and the extension is waiting for the user to press Next.
- `stopped`: the user stopped the tour.
- `error`: the tour file could not be parsed. `issues` says why.
