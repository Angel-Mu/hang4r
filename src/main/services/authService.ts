import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findBinary } from './binaryDiscovery'

const exec = promisify(execFile)

export type AuthState = 'in' | 'out' | 'unknown'

/**
 * Best-effort auth detection for the wrapped CLIs. We never store or fake auth —
 * the CLIs own it. Claude: presence of its credentials (file or keychain).
 * Codex: `codex login status`. Anything undetectable reports 'unknown'.
 */
async function claudeStatus(): Promise<AuthState> {
  if (existsSync(join(homedir(), '.claude', '.credentials.json'))) return 'in'
  // some installs keep the token only in the macOS keychain
  const ok = await exec('security', ['find-generic-password', '-s', 'Claude Code-credentials'])
    .then(() => true)
    .catch(() => false)
  return ok ? 'in' : 'out'
}

async function codexStatus(binOverride?: string | null): Promise<AuthState> {
  const bin = findBinary('codex', binOverride)
  if (!bin) return 'unknown'
  const { stdout, stderr } = await exec(bin, ['login', 'status']).catch(
    (e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '' })
  )
  const s = `${stdout}\n${stderr}`.toLowerCase()
  if (s.includes('not logged in') || s.includes('not authenticated')) return 'out'
  if (s.includes('logged in') || /@/.test(s)) return 'in'
  return 'unknown'
}

async function cursorStatus(binOverride?: string | null): Promise<AuthState> {
  const bin = findBinary('cursor-agent', binOverride)
  if (!bin) return 'unknown'
  const { stdout, stderr } = await exec(bin, ['status']).catch(
    (e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '' })
  )
  const s = `${stdout}\n${stderr}`.toLowerCase()
  if (s.includes('not logged in') || s.includes('not authenticated')) return 'out'
  if (s.includes('logged in') || /@/.test(s)) return 'in'
  return 'unknown'
}

export const AuthService = {
  async status(
    codexBin?: string | null,
    cursorBin?: string | null
  ): Promise<{ claude: AuthState; codex: AuthState; cursor: AuthState }> {
    const [claude, codex, cursor] = await Promise.all([
      claudeStatus(),
      codexStatus(codexBin),
      cursorStatus(cursorBin)
    ])
    return { claude, codex, cursor }
  },

  /** Open a Terminal window running the CLI's login flow (macOS). */
  async openLogin(backend: 'claude' | 'codex' | 'cursor'): Promise<void> {
    const cmd =
      backend === 'codex' ? 'codex login' : backend === 'cursor' ? 'cursor-agent login' : 'claude'
    // osascript opens Terminal.app and runs the login command interactively
    await exec('osascript', [
      '-e',
      `tell application "Terminal" to do script "${cmd}"`,
      '-e',
      'tell application "Terminal" to activate'
    ]).catch(() => {})
  }
}
