import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { app } from 'electron'

const exec = promisify(execFile)

export interface RemoteTestResult {
  reachable: boolean
  claudeVersion: string | null
  error?: string
}

/** an SSH host entry as stored in the `sshHosts` setting (Settings → Remote) */
export interface SshHostConfig {
  id: string
  label: string
  host: string
  dir: string
}

/** non-interactive ssh flags: never hang on a password/hostkey prompt */
const SSH_FLAGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new']

/** POSIX single-quote — the ONE quoting choke point for everything remote */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** ControlMaster socket path (one per host, hashed by ssh via %C) */
function controlPath(): string {
  return join(app.getPath('userData'), 'ssh-%C')
}

/** multiplexing flags — every ssh invocation shares one master per host */
export function sshControlFlags(): string[] {
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath()}`,
    '-o', 'ControlPersist=10m'
  ]
}

/**
 * argv for running a command on the remote in a LOGIN shell (so nvm/homebrew
 * PATHs resolve), cd'd into `dir`. For spawn() and node-pty alike.
 */
export function sshRunArgv(host: string, dir: string, remoteCmd: string): string[] {
  const inner = `cd ${shellQuote(dir)} && ${remoteCmd}`
  return [...SSH_FLAGS, ...sshControlFlags(), host, '--', `exec $SHELL -lc ${shellQuote(inner)}`]
}

/* ---------------- Exec seam (docs/ssh-design.md) ---------------- */

export interface ExecResult {
  stdout: string
  stderr: string
}

/** where a service's commands run — local subprocess or over ssh */
export interface Exec {
  run(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<ExecResult>
}

/**
 * The user's LOGIN-shell PATH, resolved once and cached. A Finder/Dock-launched
 * Electron app inherits a minimal PATH (no node/npm/gh/homebrew), so anything we
 * shell out to that depends on those breaks — Angel's PR push died on a husky
 * `pre-push` hook running `npm` ("npm: command not found"), and `gh` itself can
 * be unfindable. Ask the login shell for its real PATH via `printenv` (which
 * prints the colon-separated value regardless of shell — `echo $PATH` would come
 * back space-separated under fish, Angel's shell).
 */
let loginPathPromise: Promise<string> | null = null
function loginPath(): Promise<string> {
  if (loginPathPromise) return loginPathPromise
  const base = process.env.PATH ?? ''
  if (process.platform === 'win32') {
    loginPathPromise = Promise.resolve(base)
    return loginPathPromise
  }
  loginPathPromise = new Promise<string>((resolve) => {
    try {
      const shell = process.env.SHELL || '/bin/bash'
      const child = spawn(shell, ['-lc', 'printenv PATH'], { timeout: 5000 })
      let out = ''
      child.stdout?.on('data', (d) => (out += d.toString()))
      child.on('error', () => resolve(base))
      child.on('close', () => {
        const resolved = out.trim().split('\n').pop()?.trim() ?? ''
        // merge: login PATH first (node/npm/gh), then the base as a backstop
        resolve(resolved ? (base ? `${resolved}:${base}` : resolved) : base)
      })
    } catch {
      resolve(base)
    }
  })
  return loginPathPromise
}

export const LocalExec: Exec = {
  async run(cmd, args, opts) {
    const PATH = await loginPath()
    const { stdout, stderr } = await exec(cmd, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
      // run with the user's real PATH so git hooks (husky → npm) and gh resolve
      env: { ...process.env, PATH }
    })
    return { stdout, stderr }
  }
}

export function sshExec(host: string): Exec {
  return {
    async run(cmd, args, opts) {
      const remote = [cmd, ...args].map(shellQuote).join(' ')
      const argv = sshRunArgv(host, opts?.cwd ?? '.', remote)
      const { stdout, stderr } = await exec('ssh', argv, {
        timeout: opts?.timeout ?? 60_000,
        maxBuffer: 32 * 1024 * 1024
      })
      return { stdout, stderr }
    }
  }
}

/* ---------------- port-forward tunnels (docs/ssh-design.md v2) ---------------- */

interface Tunnel {
  localPort: number
  proc: ChildProcess
}
/** live tunnels per session, keyed by the REMOTE port */
const tunnels = new Map<string, Map<number, Tunnel>>()

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
    srv.on('error', reject)
  })
}

/**
 * Open (or reuse) an `ssh -N -L` tunnel from a fresh local port to
 * localhost:<remotePort> on the session's host. Resolves once the forward is
 * listening; rejects with ssh's own stderr if the process dies early.
 */
export async function openTunnel(
  sessionId: string,
  host: string,
  remotePort: number
): Promise<{ localPort: number }> {
  const existing = tunnels.get(sessionId)?.get(remotePort)
  if (existing && existing.proc.exitCode === null) return { localPort: existing.localPort }

  const localPort = await freePort()
  const proc = spawn('ssh', [
    ...SSH_FLAGS,
    ...sshControlFlags(),
    '-N',
    '-L',
    `127.0.0.1:${localPort}:localhost:${remotePort}`,
    host
  ])
  let stderr = ''
  proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
  proc.on('exit', () => {
    const m = tunnels.get(sessionId)
    if (m?.get(remotePort)?.proc === proc) m.delete(remotePort)
  })

  // give ssh a beat to fail fast (bad host/auth); -N means success = silence
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, 1200)
    proc.once('exit', (code) => {
      clearTimeout(t)
      reject(
        new Error(
          `tunnel to ${host}:${remotePort} failed (ssh exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`
        )
      )
    })
    proc.once('error', (err) => {
      clearTimeout(t)
      reject(err)
    })
  })

  const perSession = tunnels.get(sessionId) ?? new Map<number, Tunnel>()
  perSession.set(remotePort, { localPort, proc })
  tunnels.set(sessionId, perSession)
  return { localPort }
}

/** tear down every tunnel a session opened (archive/close) */
export function closeTunnels(sessionId: string): void {
  const m = tunnels.get(sessionId)
  if (!m) return
  for (const t of m.values()) t.proc.kill()
  tunnels.delete(sessionId)
}

/* ---------------- ControlMaster lifecycle ---------------- */

const masters = new Map<string, Promise<void>>()

/** open (or reuse) the multiplexing master for a host — pays auth once */
export function ensureMaster(host: string): Promise<void> {
  let m = masters.get(host)
  if (!m) {
    m = exec('ssh', [...SSH_FLAGS, ...sshControlFlags(), host, 'true'], { timeout: 20_000 })
      .then(() => undefined)
      .catch((err) => {
        masters.delete(host) // failed masters must not poison retries
        throw err
      })
    masters.set(host, m)
  }
  return m
}

/** tear down a host's master socket (session archived/closed) */
export async function closeMaster(host: string): Promise<void> {
  masters.delete(host)
  await exec('ssh', ['-O', 'exit', '-o', `ControlPath=${controlPath()}`, host], {
    timeout: 5_000
  }).catch(() => undefined) // no master alive is fine
}

/**
 * SSH remote environments (docs/ssh-design.md). v1 slice: host preflight —
 * is the host reachable with the user's own ssh config/keys, and does it
 * have a `claude` CLI on PATH (login shell, so nvm/homebrew paths resolve)?
 */
export const RemoteService = {
  async testHost(host: string): Promise<RemoteTestResult> {
    const target = host.trim()
    if (!target) return { reachable: false, claudeVersion: null, error: 'empty host' }
    try {
      await exec('ssh', [...SSH_FLAGS, target, 'true'], { timeout: 15_000 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // ssh's own stderr (Permission denied, Could not resolve, timeout) is the
      // useful part — surface its last line
      const line = msg.trim().split('\n').filter(Boolean).pop() ?? msg
      return { reachable: false, claudeVersion: null, error: line.slice(0, 200) }
    }
    try {
      // login shell so PATH matches the user's interactive setup
      const { stdout } = await exec(
        'ssh',
        [...SSH_FLAGS, target, '--', '$SHELL -lc "claude --version" 2>/dev/null || claude --version'],
        { timeout: 20_000 }
      )
      const version = stdout.trim().split('\n').pop() ?? ''
      return { reachable: true, claudeVersion: version || null }
    } catch {
      return { reachable: true, claudeVersion: null }
    }
  }
}
