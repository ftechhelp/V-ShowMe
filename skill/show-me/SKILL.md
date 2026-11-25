---
name: show-me
description: Gives a narrated, visual walkthrough of code in VS Code. Opens the files, highlights the exact lines, and explains them out loud step by step (text-to-speech), like a colleague showing you around. Use when the user asks to "show me", "walk me through", "give me a tour of", or explain how something in this codebase works and would benefit from seeing the code while hearing the explanation.
---

# Show Me: narrated code walkthroughs

You are giving a guided tour of code, the way a senior colleague would at the user's desk. You find the right code, decide the order to show it in, point at specific lines, and explain each part in plain spoken language.

The **ShowMe VS Code extension** does the presenting. For each step it opens the file, highlights the lines, fades out the rest, shows your narration as a caption bubble under the code, and reads it aloud. Your job is to produce **one JSON tour file**. The extension starts playing as soon as the file appears.

## Workflow

### 1. Understand before you show

- Trace the real code path with Grep, Glob and Read, from the entry point through the calls that matter. Don't build a tour from guesses about the code.
- If the request is ambiguous, pick the most useful interpretation and say which one you picked in the first step. Ask only if you really can't choose.

### 2. Plan the story

- **Number of steps:** about 8 is typical, with a range of 5–15. A narrow question ("what does this function do?") needs only 3–6.
- **Order:** follow the execution flow, or the order in which the idea builds up, not the order of the files.
- **Shape:**
  1. **Orientation.** The big picture: what we're about to see and where it starts. This is usually the entry point.
  2. **The flow.** One idea per step. Move through the code the way the data or control moves.
  3. **The interesting bits.** Point out what a colleague would: key decisions, edge cases, gotchas, and why something is done the unusual way.
  4. **Recap.** A final step **without a file**: 2–3 sentences that tie it together.
- **Keep highlights tight:** about 25 lines at most. To cover a long function, use several consecutive steps in the same file. The highlight slides down the function like a finger pointing at the screen.

### 3. Get line numbers exactly right

- Take line numbers **from your Read output**, which is 1-based. Never estimate them. If anything edited the file during this session, read it again first.
- `lines` is `[start, end]`, inclusive. Use a single number for one line.
- `anchor` is the exact text of the **first highlighted line**, trimmed. A distinctive part of it is fine. If the file changes, the extension uses it to find the range again. Always include it.
- `file` is relative to the workspace root (the folder that contains `.showme/`) and uses forward slashes.

### 4. Write narration for the ear

The narration is **spoken by a text-to-speech voice** and shown as a caption.

- Write 1–4 short sentences, about 20–60 words per step. Be conversational and use the second person: "Here we…", "Notice how…", "This is where…".
- Explain **what it does and why**: intent, trade-offs, how it connects to the previous step. Don't read code aloud or describe syntax.
- Refer to what is highlighted: "these three lines", "the check at the top", "this loop".
- Add a transition when you jump: "This calls `validateToken`, so let's hop over there."
- Put identifiers in backticks, like `findUserById`. The caption shows them as code and the voice says "find user by id".
- Avoid what sounds bad when spoken: operators and symbols, regexes, URLs, long paths, emoji, bullet lists, and many parentheses. Describe these in words instead.

### 5. Write the tour file

Write to **`.showme/tours/<YYYYMMDD-HHMMSS>-<short-slug>.json`** in the workspace root, for example `.showme/tours/20261124-153012-login-flow.json`. Get the timestamp from `date +%Y%m%d-%H%M%S`. Create the folders if they don't exist. **Writing the file starts playback.**

```json
{
  "version": 1,
  "title": "How login works",
  "steps": [
    {
      "title": "The login route",
      "file": "src/routes/auth.ts",
      "lines": [14, 22],
      "anchor": "router.post('/login', async (req, res) => {",
      "narration": "Everything starts at this route. It pulls the email and password from the request and hands them to `loginUser`, so that's where the real work happens. Let's follow it."
    },
    {
      "title": "Recap",
      "narration": "So, to recap: the route validates input, `loginUser` checks the password hash, and on success we issue a short-lived token plus a refresh cookie."
    }
  ]
}
```

The full field reference and the status file format are in [reference/tour-format.md](reference/tour-format.md).

### 6. Check that it's playing

1. Wait about 2 seconds (`sleep 2`), then read **`.showme/status.json`**.
2. `tour.file` should be your tour and `state` should be `loading` or `playing`.
3. If `issues` lists problems with your steps (file not found, anchor not found, lines past the end of the file), fix the tour and **write it again to the same path**. It restarts from step 1.
4. If `status.json` is missing or still refers to another tour after a few more seconds, the ShowMe extension probably isn't installed or running. Tell the user, and give the walkthrough as text instead.

### 7. Reply briefly in chat

Give a short outline with one line per step and `file:line` references, so the user has a written copy. Don't repeat the narration. Mention that they can pause with **Ctrl+Alt+Space**, step with **Ctrl+Alt+←/→**, and ask questions at any point.

## Questions during a tour

The user may pause and ask something that depends on context, like "wait, why is this here?", "what does that do?" or "can you explain that part again?":

1. Read `.showme/status.json`. `currentStep` says which file and lines they are looking at; `shownLines` is exactly what is highlighted.
2. Answer in chat. If showing would help, write a **short follow-up tour** (2–5 steps). It replaces the current tour.

Never edit `status.json`; the extension owns it.
