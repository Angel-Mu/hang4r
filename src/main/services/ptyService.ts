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
    extraEnv?: Record<string, string>
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
    let pty: IPty
    try {
      pty = spawn(shell, [], {
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
    this.attach(id, pty)
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

  dispose(id: string): void {
    const pty = this.ptys.get(id)
    if (pty) {
      try {
        pty.kill()
      } catch {
        // already dead
      }
      this.ptys.delete(id)
      this.buffers.delete(id)
      this.sizes.delete(id)
    }
  }

  disposeAll(): void {
    for (const id of [...this.ptys.keys()]) this.dispose(id)
  }
}
