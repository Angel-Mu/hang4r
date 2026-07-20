# The agent-drivable browser — `hang4r browser`

Every process hang4r spawns for a session — the Claude Code / Codex / Cursor agent
itself, every terminal in the Terminal panel, dev/service processes, and worktree
setup scripts — gets a `hang4r` CLI on its PATH, pre-scoped to that session. With
it, an agent can **drive the session's embedded browser pane and assert against
what it sees**: navigate, read the DOM, click, type, run JavaScript, check console
errors, take screenshots.

The one-line way to use it: tell any agent

> Run `hang4r browser --help` and use it to verify your changes in the browser.

`--help` teaches the full workflow; nothing else is required.

## How it works

```
agent / terminal / setup script
        │  hang4r browser click e42        (CLI, zero deps, on PATH)
        ▼
unix socket  <userData>/ctl.sock           (token-authed, chmod 600)
        │
        ▼
main process  browserControlService        (session → tab → guest registry)
        │  executeJavaScript / capturePage / loadURL
        ▼
the session's Browser-tab <webview>        (what the user sees on screen)
```

- The spawn environment carries `HANG4R_SESSION_ID`, `HANG4R_CTL_SOCK`, and
  `HANG4R_CTL_TOKEN`; the `hang4r` shim (written to `<userData>/bin` at boot)
  runs the CLI with the app's own Node runtime — nothing to install.
- Commands are **scoped to the calling session's own browser tabs**. One session's
  agent cannot drive another session's browser.
- The browser it drives is the real pane in the tile — you watch the agent work.

## Command reference

| Command | What it does |
| --- | --- |
| `hang4r browser tabs` | List the session's browser tabs (id, title, url, active). |
| `hang4r browser goto <url> [--tab id]` | Navigate (opens/surfaces a Browser tab if none). Reports load failures honestly (error code + description). |
| `hang4r browser snapshot [--selector css] [--compact] [--tab id]` | DOM outline with `[ref=eN]` markers on interactive elements. `--compact` keeps headings + interactive only. |
| `hang4r browser click <ref\|css>` | Click an element (scrolls it into view first). |
| `hang4r browser type <ref\|css> <text>` | Set an input/textarea value **via the native prototype setter + `input`/`change` events** — React/Vue-controlled inputs update correctly, no workaround needed. |
| `hang4r browser select <ref\|css> <value>` | Same native-setter approach for `<select>`. |
| `hang4r browser press <key>` | Key event on the focused element (Enter, Escape, Tab, arrows, single chars). |
| `hang4r browser scroll --dy N [--selector css]` | Scroll the window or an element. |
| `hang4r browser get text\|url\|title [selector]` | Read page text (capped, honest truncation marker), URL, or title. |
| `hang4r browser eval "<js>"` | Run JavaScript in the page; result printed as JSON. **The assertion workhorse.** |
| `hang4r browser wait --selector css \| --text str [--timeout ms]` | Poll until a selector matches / text appears (default 10 s); timeout errors say what they waited for. |
| `hang4r browser screenshot [path]` | PNG of the tab; prints the absolute path. |
| `hang4r browser console [--clear]` | The tab's captured console messages (last 200) — where the page's errors live. |

## The workflow (what `--help` teaches)

```bash
hang4r browser goto http://localhost:3000
hang4r browser snapshot --compact           # → elements with [ref=eN]
hang4r browser click e12                    # refs come from the LAST snapshot
hang4r browser type e7 "test@example.com"
hang4r browser wait --text "Saved" --timeout 5000
hang4r browser eval "document.querySelectorAll('.todo-item').length"   # assert
hang4r browser console                      # any errors the page logged?
hang4r browser screenshot                   # visual evidence
```

Two rules worth repeating to agents:

1. **Refs regenerate on every snapshot.** After the page changes, re-snapshot
   before clicking — a stale `eN` is an error, not a guess.
2. **Assert, don't assume.** `wait` + `eval` + `console` exist so "I clicked the
   button" can become "the row count went from 3 to 4 and the console is clean."

## Limits (by design, stated honestly)

- **The session's tile must be open in hang4r.** The webview only exists while
  the Browser pane can mount; with no tile on screen, `goto` returns an error
  telling the agent to ask you to open it. There is no headless mode.
- **SSH sessions are excluded** — the remote host can't reach your local socket.
  The env vars simply aren't injected there.
- **macOS/Linux shim** — on Windows the PATH shim is skipped (env vars still
  inject).
- Security: the socket and token file are `chmod 600` in userData; the token
  rotates every app boot; commands never cross session boundaries.

## Where things live

- CLI: `resources/ctl/hang4r-cli.js` (zero dependencies; shipped via
  electron-builder `extraResources`).
- Control plane: `src/main/services/browserControlService.ts`.
- Guest registration: `BrowserPane.tsx` reports each tab's `webContentsId` over
  `browser:guest-register`.
- E2E: `e2e/browser-cli.spec.ts` drives the real CLI against the real app.
