# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

hang4r — an Electron "agents window" for Claude Code, Codex, and Cursor CLIs (Cursor-v3-inspired multi-project agent session manager). It wraps the user's own locally installed, subscription-authenticated CLIs as subprocesses; it never calls model APIs directly, never embeds auth, and never writes to `~/.claude`. See `GOAL.md` for the definition of done and constraints (MIT-clean: no code copied from AGPL references).

## Commands

Requires Node 22.22.2 (`.nvmrc`) and the `claude` CLI installed + logged in.

```bash
nvm use
npm install            # postinstall rebuilds better-sqlite3 + node-pty for Electron
npm run dev            # electron-vite dev with HMR
npm run typecheck      # tsc on both tsconfig.node.json and tsconfig.web.json
npm run lint           # eslint --cache
npm run build          # typecheck + electron-vite build → out/
npm run e2e            # playwright test (requires a prior build — tests launch out/main/index.js)
npm run verify         # build + full e2e suite
npm run verify:real    # build + e2e/real-claude.spec.ts against the REAL claude CLI
npx playwright test e2e/session-flow.spec.ts            # single spec
npx playwright test e2e/cursor.spec.ts -g "queue"       # single test by title
```

E2E tests run the **built** app, so after changing `src/` you must `npm run build` (or use `npm run verify`) before `npm run e2e` — otherwise you're testing stale code. The suite runs single-worker with 1 retry (Electron cold-start flake); a test that fails both attempts is genuinely broken.

The fake-agent e2e suite (`HANG4R_FAKE_AGENT=1`, set by the helpers) is the regression gate; `verify:real` against the real CLI is the completion gate for agent-facing changes.

## Architecture

Electron three-process split, with `src/shared/protocol.ts` as the single source of truth for all types crossing the boundary:

- **`src/shared/protocol.ts`** — the internal ACP-shaped `AgentEvent` protocol plus all domain types (`SessionMeta`, `BackendId`, usage snapshots, …). Every backend adapter translates its native stream into `AgentEvent`; the renderer only ever sees this protocol, never backend-native output.

- **`src/main/`** — `index.ts` boots the window; `ipc.ts` registers the entire typed IPC surface (renderer calls `invoke()` channels; live data flows renderer-ward on `agent-event` / `session-updated`). Services in `src/main/services/`:
  - `sessionManager.ts` owns session lifecycle: spawns one adapter per session, routes events to the store (replayable transcript) and renderer (live), isolates worktree sessions, commits per-turn checkpoints.
  - `adapters/` — `claudeAdapter` (drives `claude -p --input-format stream-json --output-format stream-json`), `codexAdapter`, `cursorAdapter`, and `fakeAdapter` (deterministic in-process agent used when `HANG4R_FAKE_AGENT=1`). The `AgentAdapter` interface is in `adapters/types.ts`; one adapter instance == one live subprocess.
  - `store.ts` — better-sqlite3; owns all app state + transcripts (`hang4r.db` in userData).
  - Sibling services: PTY (node-pty terminals), git (worktrees/diffs/checkpoints), remote (SSH exec + tunnels — adapters and PTYs can run on a remote host), file/search, usage polling, per-backend model discovery, and importers that read existing Claude/Codex/Cursor session history.

- **`src/preload/`** — exposes the typed bridge as `window.hang4r`; e2e tests drive this bridge directly (e.g. `window.hang4r.createProject(...)`) to bypass native dialogs.

- **`src/renderer/src/`** — React 19 + zustand (single store in `state/store.ts`). `App.tsx` handles global keyboard routing; `components/Workspace.tsx` is the tiled multi-session layout of `SessionTile`s (chat + Monaco editor + xterm terminal + diff review per session).

## E2E conventions

Use the helpers in `e2e/helpers.ts`: `launchApp()` (fresh userData dir, fake agent, quiet mode), `makeScratchRepo()` (throwaway git repo with committed files), and `createProject(page, path)` via the IPC bridge. Real DnD needs the `dragTo` helper (Playwright's `dragTo` doesn't populate `dataTransfer`).

## Repo notes

- `landing/` is a separate Vite + GSAP coming-soon site, independent of the Electron app.
- `docs/` holds design research (`research-report.md`, `cursor-agent-protocol.md`, `ssh-design.md`) and the status dashboard.
