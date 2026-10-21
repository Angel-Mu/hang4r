# Control CLI + MCP — drive hang4r from outside

Status: spec, not built. Owner: Angel. Facts below were verified in the code on 2026-10-20
(`browserControlService.ts`, `ipc.ts` bridgeApi, `shared/bridge.ts`, `protocol.ts`, `sessionManager.ts`).

## 1. Intent

Angel tells an agent elsewhere (Slack bot, Buzz, Hermes, Grok bot, Codex/Claude Code in a terminal)
"work on X in hang4r". That agent calls a `hang4r` CLI (or MCP tools) to create a session, check on
it, send follow-ups, and read results. The work runs inside hang4r. Angel can open hang4r any time
and continue the same session by hand. Anti-goal: anything that reads/writes hang4r's SQLite or
signing keys (the t3code-cli anti-pattern).

## 2. User stories (5)

1. **Kick off.** From any agent: "start a codex session on project hang4r, worktree, prompt X" returns
   a session id immediately; the agent can go back to chatting with Angel.
2. **Check in.** "What is session S doing?" returns status, last result text, and whether it is
   blocked on a permission/question.
3. **Steer.** The agent sends a follow-up, or answers a permission/question the session is blocked on
   (relaying Angel's answer from Slack).
4. **Block until something happens.** `--wait` returns when the turn ends OR the session needs input.
5. **Continue in hang4r.** Angel opens hang4r; the CLI-created session is in the sidebar with a
   "via <caller>" marker, full transcript, live; he types the next prompt himself.

## 3. Architecture (one core, two front doors)

```
agent host --shell--> hang4r <cmd> ---\
agent host --stdio--> hang4r mcp -----+--> ctl.sock (app namespace) --> main: appControlService
                                           token: ctl.app.token        --> same SessionManager/Store
```

- Extend the existing unix socket (`userData/ctl.sock`, 0600). Wire stays one JSON line in, one out
  per connection: `{token, cmd:"app.<name>", args, caller}` (no `sessionId`). `wait` holds the
  connection open until it resolves.
- New file `src/main/services/appControlService.ts` owns the `app.*` dispatch. `browserControlService`
  only routes by prefix; its `browser` behavior is untouched.
- **Do not expose `bridgeApi` wholesale.** It includes `markUnseen`, `rewindSession`, `scopedFiles`,
  `submitReview`, etc. Define `CTL_METHODS` (below) as its own allowlist; reuse the same underlying
  handlers by extracting them from the `ipc.ts` closure into shared functions that both bridgeApi
  and ctl call. bridgeApi's keys/behavior (including the `HANG4R_TEST_BRIDGE_*` hooks) must not change.
- CLI side: `resources/ctl/hang4r-cli.js` keeps `browser`; new `resources/ctl/hang4r-app.js`
  (zero deps, CommonJS, like the existing file) implements the rest and `mcp`. The `argv[0]==='browser'`
  hard gate becomes a router; `browser` still requires `HANG4R_SESSION_ID`, app commands must not.

### Discovery (outside a hang4r session)

Order: `HANG4R_CTL_SOCK` + `HANG4R_CTL_APP_TOKEN` env, else `HANG4R_USER_DATA` dir, else
`~/Library/Application Support/hang4r/` (macOS only in v1). Token is read from `ctl.app.token` on
EVERY call (it rotates per boot; MCP configs must never embed it).

### Global install

Settings > General > "Install `hang4r` command" (new IPC `installCli()` / `uninstallCli()`, NOT in
BRIDGE_METHODS). Creates symlink `~/.local/bin/hang4r` -> `<userData>/bin/hang4r` (the shim is rewritten
on every boot with the current `process.execPath`, so the link survives app updates). Refuses to
replace anything that is not a symlink already pointing at hang4r's shim. If `~/.local/bin` is not on
PATH, show the exact line to add. No `/usr/local/bin`, no sudo (my call: avoids an admin prompt).

### App not running

Default: fail fast (<1 s) with exit 10 and `hang4r is not running. Start it, or pass --launch.`
`--launch` (or `HANG4R_AUTO_LAUNCH=1`) runs `open -a hang4r` and polls for the socket up to 30 s.
(My call: a GUI popping up because a Slack bot said something should be opt-in.)

## 4. Command surface (v1)

Global flags on every command: `--json` (machine output; also default when stdout is not a TTY),
`--as <name>` (caller label, default `cli`; display only, never trusted), `--launch`.
Success JSON goes to stdout; failure JSON `{"ok":false,"error":{"code","message"}}` goes to stderr.
Ids are the full session UUID; any unique prefix (>=6 chars) is accepted.

| Command | Purpose |
|---|---|
| `hang4r status` | `{ok, version, userData}`; health/discovery check |
| `hang4r projects` | list projects: `{projects:[{id,name,path,sessionCount}]}` |
| `hang4r models [--backend claude\|codex\|cursor]` | `{models:[{backend,id,label,default}]}` |
| `hang4r sessions [--project P] [--status S] [--archived] [--limit N=50]` | list, newest first |
| `hang4r sessions new [prompt\|-] [flags]` | create; `-` reads stdin; `--prompt-file F` |
| `hang4r sessions show <id>` | one session + pending request + last result |
| `hang4r sessions send <id> <prompt\|-> [--wait] [--timeout S]` | follow-up turn |
| `hang4r sessions wait <id> [--timeout S=600]` | block per section 7 |
| `hang4r sessions transcript <id> [--limit N=40] [--before CURSOR]` | readable history |
| `hang4r sessions interrupt <id>` | stop the running turn |
| `hang4r sessions respond <id> <requestId> allow\|deny` / `--option ID [--option ID...]` | answer a permission / question |
| `hang4r mcp` | stdio MCP server (section 5) |

**`sessions new` flags:** `--project P` (project id, exact name, or absolute path of an EXISTING
project; if omitted, the project whose path contains `cwd`; else exit 2), `--backend claude|codex|cursor`
(default `claude`), `--model M`, `--effort low|medium|high|xhigh|max` (codex clamps above high, cursor
ignores, same as the app), `--worktree` | `--local` (default `--worktree` for git repos, else local; my
call: "work on feature X" should not touch the main checkout), `--permission-mode
default|acceptEdits|plan|bypassPermissions` (policy: section 6), `--title T`, `--wait`, `--timeout S`.
No prompt = create an idle session (matches `createSession` without `firstPrompt`).
Not in v1: ultracode, ssh environment, attachments/images, adding projects, deleting anything.

**Session object** (`sessions`, `new`, `show`):
`{id, title, status, backend, model, effort, projectId, projectName, environment, cwd, branch,
permissionMode /*EFFECTIVE*/, origin /*"cli:<caller>"|"mcp:<caller>"|null*/, createdAt, updatedAt,
pending /*PendingRequest|null*/, lastResult /*string|null, last turn's final text, 20k cap*/, seq}`.
`seq` is the latest transcript event cursor at the moment of the call.

**PendingRequest:** `{requestId, kind:"permission"|"question", tool, summary, detail?, options:[...]}` for
permission (decisions: `allow`, `deny`); for question `{questions:[{id,text,options:[{id,label}]}]}`.

**Wait result** (`new --wait`, `send --wait`, `wait`):
`{ok:true, reason:"turn-complete"|"needs-input"|"error"|"timeout"|"archived", session:<Session>,
result, isError, errorMessage?, costUsd?}`.

**transcript:** `{events:[{seq, ts, role:"user"|"assistant"|"tool"|"system", text}], cursor:number|null}`.
Simplified text only, per-event 20k cap, no thinking blocks, no base64 images (replaced by `[image]`).
`cursor` is the `--before` value for the next older page; `null` = reached the start.

### Exit codes (stable, documented in `--help`)

| Code | Meaning |
|---|---|
| 0 | OK. For waits: turn completed without error |
| 1 | Unexpected/internal error |
| 2 | Usage error (bad flag, ambiguous project/id) |
| 3 | Session is blocked on a permission/question (`reason: needs-input`) |
| 4 | `--timeout` elapsed; the session is still running (NOT a failure of the session) |
| 5 | Session busy (`send` while running) |
| 6 | Turn ended in error (`isError`) |
| 7 | Not found (project, session, request id) |
| 8 | Refused by policy (section 6) |
| 10 | hang4r not reachable |
| 11 | Auth failed (missing/stale/wrong-scope token) |

`send` while `status` is `running`/`starting` returns exit 5 in v1 (no queue/steer/restart modes,
unlike t3code; my call to keep v1 small and avoid undefined interleaving with Angel typing in the same session).

## 5. MCP tools (as built; snake_case names and args are the PUBLIC CONTRACT)

`hang4r mcp [--as <name>] [--launch]`: stdio, newline-delimited JSON-RPC 2.0, handles `initialize`,
`ping`, `tools/list`, `tools/call` only. Hand-rolled to keep the zero-dependency property (no runtime
node_modules in the shipped app). Each call opens the socket fresh, so app restarts do not break a
long-lived MCP process. Origin shown in hang4r is `via <name>`: `--as` if given, else the client's
`clientInfo.name` from `initialize` (scrubbed like `--as`: `[\w.@:-]`, 40 chars; "claude-code" ->
"via claude-code"), else `mcp`.

Tools and arguments (all `additionalProperties:false`; `*` = required):

| Tool | Arguments |
|---|---|
| `hang4r_status` | none |
| `hang4r_list_projects` | none |
| `hang4r_list_models` | `backend` (claude\|codex\|cursor; omitted = all). Same data as `hang4r models [--backend]`: `{models:[{backend,id,label,default}]}` |
| `hang4r_list_sessions` | `limit` (integer >= 1, default 50) |
| `hang4r_new_session` | `project`, `backend`, `model`, `effort` (low\|medium\|high\|xhigh\|max), `env` (local\|worktree), `permission_mode` (default\|acceptEdits\|plan\|bypassPermissions), `title`, `prompt`, `wait` |
| `hang4r_show_session` | `session_id`* |
| `hang4r_send` | `session_id`*, `prompt`*, `wait`, `rebuild_worktree` |
| `hang4r_wait` | `session_id`*, `after` (integer >= 0), `timeout_s` (number >= 0, clamped to the cap; 0 = check once) |
| `hang4r_interrupt` | `session_id`* |
| `hang4r_respond` | `session_id`*, `request_id`*, `decision` (allow\|deny), `options` (array of option ids), `wait` |

Results are the same JSON objects as the CLI's `--json`, returned as one text content block plus
`structuredContent`. `busy`, `needs-input` and `timeout` are normal results (not errors); failures set
`isError:true` with `{code, message, exitCode}`. A timeout carries `resumeAfter` (pass it as `after` to
`hang4r_wait`).

**Wait cap.** MCP waits are capped at 50 s per call (`HANG4R_MCP_WAIT_CAP_S`) because MCP clients commonly
time out tool calls near 60 s; on the cap a wait returns `reason:"timeout"` and the agent calls
`hang4r_wait` again. `new_session`/`send`/`respond` accept `wait:true` under the same cap. No progress
notifications in v1.

**`wait:true` is two socket calls** (act, then wait) so a timeout is resumable. If the act succeeds and
the wait call fails (app quit, unreachable), the result is `isError:true` with `sent:true`, the acted
`session` and `after`, and a hint to call `hang4r_wait` and NOT to re-send or create another session.

## 6. Security model

**Who can call:** any process of the same OS user that can read `userData/ctl.app.token` (0600) and
open `ctl.sock` (0600). No network listener exists or is added.

**Is same-user token readability acceptable? Yes.** The same user can already read `hang4r.db`, run
`claude --dangerously-skip-permissions` directly, and read `~/.claude`. The token is not a boundary
against the user's own processes; it stops other OS users and web pages. What it must not become is a
bridge from a *constrained* hang4r agent to an unconstrained one.

**Token scope (new, this is the important change).** Today every spawned agent gets `HANG4R_CTL_TOKEN`
and the socket takes a caller-supplied `sessionId`. If that token also authorized `app.*`, a `plan`-mode
agent inside hang4r could create a `bypassPermissions` session. So:
- Two tokens, both per-boot `randomUUID`: the existing **session token** (injected in `sessionEnv`,
  accepted ONLY for `browser` commands) and a new **app token** in `ctl.app.token`, never put in
  `sessionEnv`/PTY env, accepted ONLY for `app.*`. A wrong-scope token returns auth error (exit 11).
- Caveat stated plainly: an agent running with file-read access can still read `ctl.app.token`. This
  is defense in depth against accidental env leakage, not a sandbox. Agents inside hang4r calling the
  global CLI is out of scope for v1.

**The real threat is content, not the token:** a Slack/web-fed agent passes attacker-influenced text as
the prompt of a session that executes code on Angel's machine. That is what the permission policy
below is for.

**Allowed (`CTL_METHODS`):** listProjects, listSessions, listArchivedSessions, getSessionEventsPage,
createSession, prompt, interrupt, respondPermission, respondQuestion, archiveSession, agentAlive,
resolveAgentDefault, listCodexModels, listCursorModels, appVersion, currentBranch, plus claude model
list via the shared module. **Excluded:** delete, git writes/PRs, terminals/PTY, settings writes,
file read/write/search, `setSessionPermissionMode` and `setSessionModel` (no escalating or swapping a
live session; v1), rewind, markSeen/markUnseen, ssh, importers, browser.
**Audit:** every `app.*` call logs `{ts, cmd, caller, sessionId}` to the main-process console; created
sessions persist `origin`. `caller` is self-declared and display-only.
**Projects:** callers can only use projects already added in the app; cwd-by-path never adds one.

### Permission mode policy for externally created sessions (DECISION FOR ANGEL)

Facts: `bypassPermissions` makes the Claude adapter pass `--dangerously-skip-permissions` (Codex/Cursor
have equivalents), so nothing ever prompts. Any other mode makes the agent block on `permission-request`
until someone answers via the UI, phone, or `sessions respond`. hang4r has no timeout on a pending
request today, and nothing auto-approves.

| Option | Behavior | Trade-off |
|---|---|---|
| A. Open | Any mode allowed from the CLI | One prompt-injected Slack message = unattended code execution as Angel |
| **B. Gated (recommended)** | Default mode when `--permission-mode` is omitted: the app's resolved default for that backend (`resolveAgentDefault`) **capped at `acceptEdits`**. `bypassPermissions` is refused (exit 8) unless the new setting **"Allow external callers to create bypass sessions"** (Settings, default OFF) is on. The effective mode is always returned in the session object. | One toggle; hands-off flows still work through `acceptEdits`/`plan`, and `needs-input` makes the caller or Angel the approver |
| C. Never | Bypass can never be requested externally | Safest, but blocks the fully-autonomous overnight case Angel may want |

**Unanswered requests (all options):** the session stays blocked and visible. hang4r never auto-allows
and never auto-denies on a timer. `--wait` returns `needs-input` (exit 3) so the caller can relay to a
human; the sidebar shows the existing blocked indicator; Angel can answer in-app at any time. A caller
may answer via `respond`, which counts as that caller's approval (it is the trusted approver; no extra
gate in v1). Callers needing a hard stop use `interrupt`.

## 7. Wait and streaming semantics

- No streaming of tokens in v1. Callers poll `show`/`transcript` or block with `wait`.
- `new`/`send` return `seq` (event cursor at submit). `wait` only considers events with `seq` greater
  than the one returned by the latest submit it is attached to (`new/send --wait` do this internally;
  standalone `wait` uses "now"), so a stale `turn-complete` never satisfies it.
- `wait` is level-triggered and resolves on the FIRST of: `turn-complete` (reason `turn-complete`, or
  `error` when `isError`); an unresolved `permission-request`/`question-request` (including one already
  pending when `wait` is called; derived from the transcript, `needs-input`); status `error`/`archived`;
  timeout (`timeout`). Also: if the session is `idle` with no turn in flight, return immediately with the last result.
- A resolved turn boundary is held until the session status leaves `running` (the transcript event is
  broadcast before the status flips). The hold applies ONLY while status is `running`, never `starting`
  (a claim sets `starting` before the next turn's user-text exists, and can park there through a worktree
  rebuild), and only while no `user-text` follows that boundary. `user-text` is a wake event, because
  codex records it after the status is already `running`.
- `--timeout` seconds, default 600, max 3600, 0 = poll once. Timeout never interrupts the agent.
- Server side subscribes to the existing session-event broadcast (no polling loop, no new DB reads
  beyond the initial pending check). Closing the socket (Ctrl-C, caller killed) cancels only the wait.
- If hang4r quits mid-wait the connection drops: CLI exits 10 with `app-quit`. Sessions follow the
  existing restart behavior (running/starting reset to idle).

## 8. Visibility and origin

- Add nullable `origin TEXT` on `sessions` (migration in `store.ts`), `SessionMeta.origin?: string`.
  Set only by `app.createSession`. Existing rows and UI-created sessions stay null.
- Sidebar row and session header show a small "via <caller>" chip when `origin` is set. A session
  created while no window is open must show correctly on next window open; with a window open it
  appears live through the existing `session-updated` broadcast (no reload).
- Continuing in-app is just the normal path: same `SessionManager`, same adapter, same transcript.
  No "external" state, no read-only mode.

## 9. Exit criteria

Fake agent (`HANG4R_FAKE_AGENT=1`; new `e2e/control-cli.spec.ts`, runs the real CLI as an async
subprocess against the built app, like `browser-cli.spec.ts`; uses fake triggers `ask permission` and
`ask a question`, plus a slow-turn trigger added to fakeAdapter if none exists):

1. `sessions new "hi" --wait --json --as test` exits 0, `reason:"turn-complete"`, result non-empty;
   `window.hang4r.listSessions()` has it with `origin:"cli:test"`, and the sidebar shows the chip.
2. `sessions new` with no prompt creates an `idle` session; `send --wait` runs a turn on it.
3. `send` on a running session exits 5; `interrupt` then returns it to idle.
4. `ask permission` prompt: `wait` exits 3 with `pending.kind:"permission"`; `respond allow`; `wait` exits 0.
   Same for `ask a question` with `--option`. Unanswered: still pending after 5 s, never auto-resolved.
5. `wait --timeout 1` on a slow turn exits 4 and the session is still `running`.
6. Policy: with the setting off, `--permission-mode bypassPermissions` exits 8; omitted mode with an app
   default of bypass yields effective `acceptEdits`; with the setting on, bypass is accepted.
7. Auth: session token on `app.*` and app token on `browser` both exit 11; unknown `HANG4R_USER_DATA`
   exits 10 in under 1 s; `--launch` is covered by a unit test of the polling loop only.
8. `transcript` pages: `--limit 2` then `--before cursor` walk to `cursor:null`; image content is `[image]`.
9. `hang4r mcp`: initialize, `tools/list` returns exactly the 11 tools, `tools/call hang4r_session_new`
   works, a 50 s cap is asserted via an injected short cap env.
10. `installCli` into a temp HOME creates the symlink; refuses a pre-existing regular file; `uninstallCli` removes only ours.
11. Regression: `browser-cli.spec.ts` and `bridge.spec.ts` unchanged and green; a test asserts
    `BRIDGE_METHODS` is deep-equal to a pinned list; `npm run typecheck && npm run lint` clean.
12. Static check: neither `resources/ctl/*.js` nor `appControlService.ts` contains the string `.claude`
    or opens `hang4r.db`.

Real claude (`npm run verify:real`, add `e2e/real-control-cli.spec.ts`): `sessions new "Reply with
exactly PONG" --backend claude --local --wait --json` exits 0 with `PONG` in `result`; then, in the app
via the bridge, `prompt` "What did I ask you to reply with?" and assert the answer mentions PONG
(same `backendSessionId`, context carried: "continue in hang4r" proven); `mcp` `tools/call` does the same once.
Follow the repo rule: run ONE gate at a time.

## 10. Out of scope for v1

Remote/HTTP/TCP exposure or auth; ACP server (Buzz can shell out or use MCP); the Slack bot or any
chat integration; deep links (`hang4r://`) and single-instance lock; `projects add`; ssh sessions;
ultracode; attachments/images; queue/steer/restart send modes; token streaming and MCP progress
notifications; `setSessionPermissionMode`/`setSessionModel` over ctl; Windows/Linux discovery paths;
agents inside hang4r using the app namespace; approval-delegation rules; rate limiting; npm/brew
packaging of the CLI separately from the app; Android/mobile changes.

## 11. Must NOT change

- Mobile bridge: `BRIDGE_METHODS`, `bridgeApi` semantics, relay frames, phone behavior and e2e (`bridge*.spec.ts`).
  Extracting shared handlers is allowed only if those specs stay green untouched.
- `hang4r browser`: commands, flags, env (`HANG4R_CTL_SOCK`, `HANG4R_CTL_TOKEN`, `HANG4R_SESSION_ID`),
  output, and PATH injection via `sessionEnv`; session-token auth semantics stay as they are for `browser`.
- Never write to `~/.claude` (or `~/.codex`, `~/.cursor`) from the CLI, MCP server, or new service.
- No new network listener. Socket/token files stay 0600. Existing sessions' status, permission mode, and transcripts are untouched.
- No desktop release without Angel's explicit go.

## 12. Where this can break something else

- `ctl.sock` is unlinked at start with no single-instance lock: two running instances (dev + prod)
  make the CLI hit whichever bound last. Pre-existing; mitigated by `HANG4R_USER_DATA`. Document it.
- `store.ts` migration for `origin`: follows the existing additive-column pattern; verify old DBs open.
- Extracting bridgeApi handlers touches `ipc.ts` (223x churn file); keep it a pure move.
- `wait` holds sockets open: ensure `dispose()` and quit close them (the quit crash note: do not remove `app.exit(0)`).
- The interrupt guard counts live work; a CLI-started running turn is an agent turn and already counts. No change expected, verify.
- Sessions finishing while no one is looking should raise the existing finished-unseen badge; confirm it keys on session events, not on UI-originated prompts.

---

## Decisions in force (2026-10-20) — OVERRIDE anything above that conflicts

Angel's calls:
- **Permission policy: OPEN.** Any `--permission-mode` incl. `bypassPermissions` is allowed from the CLI. No Settings toggle, no exit 8 for bypass. `respond` (allow/deny/answer) stays — the external agent is meant to drive "as if it were Angel". Unanswered requests still never auto-resolve on a timer.
- **Environment is a parameter:** `--env local|worktree` (ssh out of v1). Omitted → the same default the app's Start-agent modal would pick for that project/backend.

From the Ultron review (accepted):
1. **One token, no split.** Drop `ctl.app.token`/scope tests. App commands are also allowed from inside hang4r sessions (an agent orchestrating other sessions is a feature). The real boundary is the OS user; say so in docs.
2. **Prompt lock in the core.** `SessionManager.prompt` must atomically claim the session (status → `starting`) BEFORE its first await and reject if busy — for EVERY caller (renderer, bridge, ctl). Renderer queued-message flush must handle the rejection (keep the message queued, retry on next idle). `send` to a busy session → exit 5.
3. **`wait` is turn-correlated.** `send`/`new` return the seq of the user-text they produced; `wait --after <seq>` (CLI does this automatically after its own send) returns `turn-complete` only for a turn-complete AFTER that seq. Nothing in flight → reason `idle` (not success-with-old-result). Agent died / restart mid-turn → reason `error`, exit non-zero.
4. **Pending request = live only:** unresolved, newer than last turn-complete/exit, adapter alive. `respond` to a non-live request → exit 7 (no silent success).
5. **Never prompt modally from ctl.** Missing worktree on a ctl `send` → fail with a code (or rebuild only with `--rebuild-worktree`). No `askWorktreeChoice` dialog.
6. **Socket hygiene:** unsubscribe waiters on socket `close`; destroy open sockets in `dispose()`.
7. **Install safety:** refuse install when app path contains `AppTranslocation`; shim checks the electron binary exists, falls back to `/Applications/hang4r.app`.
8. **Per-message origin label:** externally sent user-text carries a "via <caller>" label (displayText/label field, NOT altering sent text) so Angel sees which turns came from outside, also in his own sessions.

Cuts for v1: `models` paging, transcript paging (show returns lastResult + last N events), list filters, id prefixes. `--launch` stays (cheap).

Phasing: **Phase 1** = core lock + ctl app namespace + CLI + install + UI origin chips/labels, gated. **Phase 2** = `hang4r mcp` stdio wrapper (Hermes consumes MCP), thin over the same socket calls, MCP wait cap configurable (default 50s).
