import { spawn, type IPty } from 'node-pty'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform, homedir, userInfo } from 'node:os'
import { shellQuote, sshControlFlags } from './remoteService'

/**
 * Resolve which shell to launch: an explicit user setting wins; else $SHELL;
 * else — critically for GUI/packaged launches where $SHELL is unset — the real
 * login shell (via `dscl` on macOS), so a fish/bash user gets THEIR shell, not
 * a zsh fallback. (Exported: worktree setup scripts run through the same shell
 * so they see the same PATH as the user's terminal.)
 */
export function resolveShell(override?: string): string {
  if (override && override.trim()) return override.trim()
  if (platform() === 'win32') return 'powershell.exe'
  if (process.env.SHELL && existsSync(process.env.SHELL)) return process.env.SHELL
  if (platform() === 'darwin') {
    try {
      const out = execFileSync('dscl', ['.', '-read', `/Users/${userInfo().username}`, 'UserShell'], {
        encoding: 'utf8'
      })
      const m = /UserShell:\s*(\S+)/.exec(out)
      if (m && existsSync(m[1])) return m[1]
    } catch {
      /* fall through */
    }
  }
  return '/bin/zsh'
}

/**
 * Manages pseudo-terminals, one per terminal pane. Terminals run in a session's
 * working directory (its worktree or repo path), giving each agent session a
 * real shell for tests, builds, and manual pokes — the Cursor terminal pane.
 */
/** cap on retained per-terminal scrollback replayed on re-attach */
const RING_MAX = 256 * 1024
/** grace after a group SIGTERM before we SIGKILL any straggler on a normal
 *  dispose (tab close) — long enough for a dev server to flush and release its
 *  port, short enough that a stuck one still dies promptly */
const DISPOSE_GRACE_MS = 400

export class PtyService {
  private ptys = new Map<string, IPty>()
  /** last-N bytes of output per terminal, so a re-mounted xterm shows scrollback */
  private buffers = new Map<string, string>()
  /** last size we actually sent to each pty — a re-attach (tab switch) refits the
   *  fresh xterm to the SAME size and resends it; forwarding that no-op resize
   *  fired a SIGWINCH that made the shell reprint its prompt on every switch,
   *  piling duplicate prompts/worktree-status into the scrollback (Angel). */
  private sizes = new Map<string, { cols: number; rows: number }>()
  /** ids started via startCommand (dev/service processes) → their command. These
   *  are intentionally-running processes, so they count as "busy" for the quit
   *  guard regardless of pty.process (which reports the wrapping `fish -lc`
   *  shell, making a live dev server look idle — Angel quit with them running
   *  and got NO warning). */
  private commandPtys = new Map<string, string>()

  /**
   * Every command pty we have started, keyed by its process GROUP id — node-pty
   * setsid()s, so `pty.pid` IS the pgid.
   *
   * This is the ONLY handle that survives a command which backgrounds a child
   * and returns: `pty.onExit` drops the id from every other map the moment the
   * LEADER exits, and the backgrounded child — still in the leader's group, and
   * reparented to init — then holds its port with nothing tracking it. Kept
   * until the group has no live members left.
   */
  private startedGroups = new Map<number, { id: string; command: string }>()

  constructor(
    private onData: (id: string, data: string) => void,
    private onExit: (id: string, code: number) => void
  ) {}

  private appendBuffer(id: string, data: string): void {
    const cur = (this.buffers.get(id) ?? '') + data
    this.buffers.set(id, cur.length > RING_MAX ? cur.slice(cur.length - RING_MAX) : cur)
  }

  start(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    shellOverride?: string,
    sshHost?: string,
    extraEnv?: Record<string, string>,
    /** run the shell as a LOGIN shell (-l) so it sources ~/.zprofile etc., like
     *  Terminal.app / iTerm. Opt-in (default off = interactive-only, ~/.zshrc) so
     *  it never changes existing terminals unless the user asks for it. */
    loginShell = false
  ): void {
    // Re-attach: the PTY is still alive (only the xterm was unmounted on a tab
    // switch). Replay buffered scrollback into the fresh xterm instead of a
    // silent no-op (which left the terminal blank).
    if (this.ptys.has(id)) {
      const buf = this.buffers.get(id)
      if (buf) this.onData(id, buf)
      return
    }
    if (sshHost) {
      // remote shell over a forced-TTY ssh — NO BatchMode here, so first-time
      // auth prompts (passphrase/2FA) render right in this terminal. Resize
      // propagates via the pty (SIGWINCH → remote).
      let pty: IPty
      try {
        pty = spawn(
          'ssh',
          ['-tt', ...sshControlFlags(), sshHost, '--', `cd ${shellQuote(cwd || '~')} 2>/dev/null; exec $SHELL -l`],
          {
            name: 'xterm-color',
            cwd: homedir(),
            cols: cols || 80,
            rows: rows || 24,
            env: process.env as Record<string, string>
          }
        )
      } catch (err) {
        this.onData(id, `\r\n[hang4r] failed to start ssh terminal: ${String(err)}\r\n`)
        return
      }
      this.appendBuffer(id, `\r\n\x1b[2m$ ssh ${sshHost}\x1b[0m\r\n`)
      this.attach(id, pty)
      return
    }
    const shell = resolveShell(shellOverride)
    // node-pty throws if cwd doesn't exist — fall back to home defensively
    const safeCwd = cwd && existsSync(cwd) ? cwd : homedir()
    // login shell (-l) sources ~/.zprofile/PATH like a normal macOS terminal;
    // powershell on win32 has no such flag, so never add it there
    const shellArgs = loginShell && platform() !== 'win32' ? ['-l'] : []
    let pty: IPty
    try {
      pty = spawn(shell, shellArgs, {
        name: 'xterm-color',
        cwd: safeCwd,
        cols: cols || 80,
        rows: rows || 24,
        // extraEnv carries the hang4r browser CLI's socket/token/session so an
        // agent working in this terminal can drive the browser pane
        env: { ...(process.env as Record<string, string>), ...extraEnv }
      })
    } catch (err) {
      this.onData(id, `\r\n[hang4r] failed to start shell: ${String(err)}\r\n`)
      return
    }
    this.attach(id, pty)
  }

  /**
   * Run a shell COMMAND in a pty (dev/service processes declared per workspace).
   * Long-lived; dispose() kills the process. Re-attach replays scrollback.
   */
  startCommand(
    id: string,
    cwd: string,
    command: string,
    cols: number,
    rows: number,
    extraEnv?: Record<string, string>
  ): void {
    if (this.ptys.has(id)) {
      const buf = this.buffers.get(id)
      if (buf) this.onData(id, buf)
      return
    }
    const shell = resolveShell()
    const safeCwd = cwd && existsSync(cwd) ? cwd : homedir()
    let pty: IPty
    try {
      pty = spawn(shell, ['-lc', command], {
        name: 'xterm-color',
        cwd: safeCwd,
        cols: cols || 80,
        rows: rows || 24,
        env: { ...(process.env as Record<string, string>), ...extraEnv }
      })
    } catch (err) {
      this.onData(id, `\r\n[hang4r] failed to start process: ${String(err)}\r\n`)
      return
    }
    this.appendBuffer(id, `\r\n\x1b[2m$ ${command}\x1b[0m\r\n`)
    this.commandPtys.set(id, command)
    if (pty.pid > 1) this.startedGroups.set(pty.pid, { id, command })
    this.attach(id, pty)
  }

  /** pids still alive in a process group, leader included. */
  private groupMembers(pgid: number): number[] {
    if (platform() === 'win32') return []
    try {
      return execFileSync('ps', ['-o', 'pid=', '-g', String(pgid)], { timeout: 4000 })
        .toString()
        .split('\n')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 1)
    } catch {
      // no members left (ps exits non-zero on an empty group)
      return []
    }
  }

  /**
   * Commands whose pty LEADER is gone but whose process group still has live
   * members — the self-detaching dev server that keeps its port with nothing
   * tracking it. Prunes groups that have finally emptied.
   *
   * A child that calls setsid() for itself leaves the group and is genuinely
   * beyond our reach; everything that merely backgrounds with `&` stays.
   */
  detached(): { count: number; names: string[] } {
    const names: string[] = []
    for (const [pgid, info] of [...this.startedGroups]) {
      if (this.ptys.has(info.id)) continue // leader alive → busyCount() has it
      if (this.groupMembers(pgid).length === 0) {
        this.startedGroups.delete(pgid)
        continue
      }
      names.push(info.command.trim().split(/\s+/)[0] || info.command)
    }
    return { count: names.length, names }
  }

  /** true while anything the id started is still alive — the leader, or a child
   *  it left behind. */
  hasLiveGroup(id: string): boolean {
    if (this.ptys.has(id)) return true
    for (const [pgid, info] of this.startedGroups) {
      if (info.id === id && this.groupMembers(pgid).length > 0) return true
    }
    return false
  }

  /** SIGKILL whatever an id left behind after its leader exited. */
  killDetached(id: string): void {
    for (const [pgid, info] of [...this.startedGroups]) {
      if (info.id !== id) continue
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        /* group already gone */
      }
      this.startedGroups.delete(pgid)
    }
  }

  /** whether a pty with this id is currently alive */
  isRunning(id: string): boolean {
    return this.ptys.has(id)
  }

  /** count of undisposed ptys (terminals + dev/service processes) */
  liveCount(): number {
    return this.ptys.size
  }

  /**
   * Count of ptys with a real FOREGROUND process (npm, vim, a build…) — an
   * idle shell prompt shouldn't block quitting the app. node-pty's `process`
   * reports the current foreground process name; when it's just the shell
   * itself (or the transient `login`), nothing of the user's is running.
   */
  /** the same terminals busyCount() counts, but addressable — the quit dialog
   *  offers a Stop per row */
  busyItems(): { id: string; name: string }[] {
    const IDLE = new Set(['fish', 'zsh', 'bash', 'sh', 'dash', 'login', 'powershell.exe', ''])
    const out: { id: string; name: string }[] = []
    for (const [id, pty] of this.ptys) {
      const cmd = this.commandPtys.get(id)
      if (cmd) {
        out.push({ id, name: cmd.trim().split(/\s+/)[0] || cmd })
        continue
      }
      try {
        const name = (pty.process ?? '').split('/').pop() ?? ''
        if (!IDLE.has(name.toLowerCase())) out.push({ id, name })
      } catch {
        /* pty died mid-iteration — not busy */
      }
    }
    return out
  }

  /** detached survivors, addressable the same way */
  detachedItems(): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = []
    for (const [pgid, info] of [...this.startedGroups]) {
      if (this.ptys.has(info.id)) continue
      if (this.groupMembers(pgid).length === 0) {
        this.startedGroups.delete(pgid)
        continue
      }
      out.push({ id: info.id, name: info.command.trim().split(/\s+/)[0] || info.command })
    }
    return out
  }

  busyCount(): { count: number; names: string[] } {
    const IDLE = new Set(['fish', 'zsh', 'bash', 'sh', 'dash', 'login', 'powershell.exe', ''])
    const names: string[] = []
    for (const [id, pty] of this.ptys) {
      // dev/service processes (Processes tab): always busy while alive — they run
      // a real command under a `fish -lc` wrapper, so pty.process would report
      // the idle shell and miss them. Show the command's first word.
      const cmd = this.commandPtys.get(id)
      if (cmd) {
        names.push(cmd.trim().split(/\s+/)[0] || cmd)
        continue
      }
      try {
        const name = (pty.process ?? '').split('/').pop() ?? ''
        if (!IDLE.has(name.toLowerCase())) names.push(name)
      } catch {
        /* pty died mid-iteration — not busy */
      }
    }
    return { count: names.length, names }
  }

  private attach(id: string, pty: IPty): void {
    pty.onData((data) => {
      this.appendBuffer(id, data)
      this.onData(id, data)
    })
    pty.onExit(({ exitCode }) => {
      this.onExit(id, exitCode)
      this.ptys.delete(id)
      this.commandPtys.delete(id)
      this.buffers.delete(id)
      this.sizes.delete(id)
    })
    this.ptys.set(id, pty)
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const c = Math.max(cols, 1)
    const r = Math.max(rows, 1)
    // skip a no-op resize: an unchanged SIGWINCH still makes the shell reprint
    // its prompt, which duplicated the scrollback on every tab switch (Angel)
    const prev = this.sizes.get(id)
    if (prev && prev.cols === c && prev.rows === r) return
    this.sizes.set(id, { cols: c, rows: r })
    try {
      this.ptys.get(id)?.resize(c, r)
    } catch {
      // resize can throw if the pty just exited; ignore
    }
  }

  /** ⌘K clear: drop the retained scrollback so a later re-attach (tab switch)
   *  replays nothing — otherwise the cleared terminal looked polluted again the
   *  moment you came back to it (Angel). The live shell keeps running. */
  clearBuffer(id: string): void {
    this.buffers.set(id, '')
  }

  /**
   * Kill a pty's ENTIRE process group, not just the shell leader. node-pty runs
   * the shell via forkpty→setsid, so the shell is a session/group leader
   * (pgid == pty.pid) and its children — the `npm run dev` → node dev server that
   * actually binds the port — share that group. `pty.kill()` signals ONLY the
   * leader: a child that OBEYS SIGHUP then dies via the terminal-hangup cascade,
   * but a child that installs a SIGHUP handler or detaches into its own worker
   * survives and keeps the port bound (Angel: quit hang4r, the port stays
   * occupied). Signalling the NEGATIVE pid hits the whole group, so even a
   * SIGHUP-resistant dev server dies and the port frees. Returns true iff the
   * group signal was actually sent (so the caller can schedule a follow-up).
   */
  private killGroup(pty: IPty, signal: NodeJS.Signals): boolean {
    // Windows has no POSIX process groups; node-pty tears down the job object there
    if (platform() === 'win32') {
      try {
        pty.kill()
      } catch {
        /* already dead */
      }
      return false
    }
    const pid = pty.pid
    // guard: a falsy/≤1 pid would make process.kill(-pid) signal our OWN group
    // (or init) — never risk that; fall back to the leader-only kill
    if (!pid || pid <= 1) {
      try {
        pty.kill()
      } catch {
        /* already dead */
      }
      return false
    }
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      // ESRCH (group already gone) / EPERM — best-effort leader kill
      try {
        pty.kill()
      } catch {
        /* already dead */
      }
      return false
    }
  }

  dispose(id: string): void {
    // before the early return: a detached command has no live leader, and its
    // survivor is exactly what Stop needs to reach
    this.killDetached(id)
    const pty = this.ptys.get(id)
    if (!pty) return
    // drop bookkeeping up front so busyCount()/re-attach treat it as gone even
    // while the process is still winding down from SIGTERM
    this.ptys.delete(id)
    this.commandPtys.delete(id)
    this.buffers.delete(id)
    this.sizes.delete(id)
    const pid = pty.pid
    // graceful: SIGTERM the whole group (let a dev server flush + release its
    // port), then SIGKILL any straggler still alive after a short grace period
    if (this.killGroup(pty, 'SIGTERM') && pid > 1) {
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* group already gone */
        }
      }, DISPOSE_GRACE_MS)
    }
  }

  disposeAll(): void {
    // App-quit teardown: index.ts SIGKILLs the whole process IMMEDIATELY after
    // this returns (to dodge node-pty's crash-on-teardown), so a deferred kill
    // would never land. SIGKILL each process GROUP synchronously here so no dev
    // server / port holder can outlive the app.
    for (const [id, pty] of [...this.ptys]) {
      this.ptys.delete(id)
      this.commandPtys.delete(id)
      this.buffers.delete(id)
      this.sizes.delete(id)
      this.killGroup(pty, 'SIGKILL')
    }
    // …and the groups whose leader already exited, which the loop above can no
    // longer see. Without this a self-detached dev server outlives the app and
    // keeps its port until it's hunted down by hand.
    for (const pgid of [...this.startedGroups.keys()]) {
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        /* group already gone */
      }
      this.startedGroups.delete(pgid)
    }
  }
}
