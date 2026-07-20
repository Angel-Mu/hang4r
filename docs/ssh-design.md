# SSH remote environments — design (v1)

*Status: scoped 2026-07-06 · the last GOAL.md item. Decisions below are chosen, not options.*

## The model: run everything on the remote host

Cursor-style remote means **the agent executes remotely** — the repo, the tools, the
hooks, the dev server all live on the remote machine; hang4r is a window onto it.
The alternative (local `claude` with a remote-mounted workdir) breaks every tool the
agent runs (`npm`, compilers, hooks) and is rejected.

This fits hang4r's architecture unusually well because **every backend integration is
already a subprocess speaking stdio**:

| Layer | Today (local) | SSH v1 |
|---|---|---|
| Agent (claudeAdapter) | `spawn(claude, args, {cwd})`, stream-json over stdio | `spawn('ssh', [host, '--', 'cd <dir> &&', claude, ...args])` — **stream-json flows through unchanged**; the control protocol (permissions, set_model, interrupt) too |
| Terminal (ptyService) | `node-pty spawn($SHELL)` | `node-pty spawn('ssh', ['-tt', host])` + `cd <dir>` on first line — full PTY semantics (resize via SIGWINCH works over -tt) |
| Git (gitService) | `execFile('git', ['-C', cwd, ...])` | `execFile('ssh', [host, '--', 'git', '-C', dir, ...])` — same parsing, quoted args |
| Files (fileService) | `fs.readFile/writeFile/readdir` | batched `ssh host` commands for list/stat (one `find`-style call per tree level) + `cat`/`tee` for read/write. SFTP protocol not needed in v1 — plain exec keeps one transport |
| Processes tab | local PTY per command | same `ssh -tt` PTY |
| Search service | local fs walk | remote `grep -rn` fallback (or defer: v1 can mark search "local/worktree only") |

**Auth/billing invariant holds**: the *remote* host's `claude` CLI must be installed
and logged in (`ssh host claude --version` is the preflight check). hang4r never
transports credentials.

## Transport: OpenSSH client subprocess, not the ssh2 library

Decision: shell out to the user's `ssh`/`scp`.
- Free inheritance of `~/.ssh/config` (aliases, keys, `ProxyJump`, agent forwarding,
  1Password/agent integrations) — the exact setup the user already trusts in their
  terminal. ssh2 would re-implement all of it, badly, plus native-module pain in
  Electron packaging.
- **ControlMaster multiplexing** makes per-command exec cheap: hang4r opens one
  master (`ssh -o ControlMaster=auto -o ControlPath=<userData>/ssh-%C -o
  ControlPersist=10m host true`) per session; every subsequent `ssh`/`git`/file call
  reuses the socket (~10ms, no re-auth).
- Interactive auth (passphrase/2FA) happens once, in a visible PTY: the master
  connection is opened through node-pty so prompts render in the session's Terminal
  panel. After that, everything is non-interactive.

## Data model

- `EnvironmentKind = 'local' | 'worktree' | 'ssh'`.
- New `RemoteHost` setting (Settings → Remote): `{ id, label, host }` where `host` is
  any `ssh`-resolvable target (`user@ip`, config alias). Plus per-host `remoteDir`
  default. Stored in the existing settings store.
- `SessionMeta` gains `remoteHostId?: string`; `cwd` holds the *remote* path for ssh
  sessions. A single `isRemote(session)` helper gates the service-layer branches.
- Services get an internal seam: `Exec` interface (`run(cmd, args, opts)`) with
  `LocalExec` and `SshExec(host)` implementations; gitService/fileService take it
  instead of calling `execFile` directly. This is the only refactor with real surface
  area, and it's mechanical.

## What v1 ships

1. Settings: add/remove SSH hosts + "test connection" (runs `ssh host true` +
   `claude --version`, shows both results).
2. New Agent dialog: Environment = SSH → host picker + remote directory field.
3. Claude sessions on the remote host: full chat, permissions, rewind (jsonl lives
   remotely — `findRewindAnchor` runs over `ssh cat`), terminal, git status/diff/
   stage/commit, file browse/edit, diff panel.
4. Preflight with clear errors: unreachable host, no claude on PATH, dir missing.

## Out of scope for v1

- Worktrees on the remote (env is `ssh`, not `ssh+worktree`) — remote dir is used
  as-is, like `local`.
- Codex remote, best-of-N remote, Processes tab remote commands (buttons hidden).
- Search-in-files on remote (panel shows "not yet available on SSH sessions").
- Port forwarding / opening the remote dev server in the Browser pane (v2: `-L`
  tunnels — high value, right after v1).
- File watching / live git-gutter refresh (manual refresh only on remote).
- Windows remotes (POSIX remote assumed; local Windows client is fine).

## Risks

- **Latency on the file tree**: mitigated by one-call-per-level listing + caching;
  editor loads are single `cat`s.
- **Quoting across the ssh boundary**: single choke point — `SshExec` builds argv
  with a tested `shellQuote`; no string-concatenated commands anywhere else.
- **Zombie masters**: `ControlPersist=10m` + explicit master teardown on session
  archive/close.

## Sequencing (each lands green through the normal gates)

1. `Exec` seam + `SshExec` + ControlMaster lifecycle + Settings hosts UI.
2. Remote claudeAdapter spawn + preflight + New Agent SSH option (chat works).
3. PTY-over-SSH terminal; git over ssh; file browse/edit.
4. Rewind-over-ssh, diff media (base64 via `git show | base64`), polish + e2e
   against a loopback `ssh localhost` fixture (CI-safe: skip when no sshd).
