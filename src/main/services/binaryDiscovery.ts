import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Locate an agent CLI binary (claude, codex, ...) the way opcode does it:
 * explicit override → `which` → nvm installs → standard locations.
 * GUI apps on macOS don't inherit the shell PATH, so `which` alone is not enough.
 */
export function findBinary(name: string, override?: string | null): string | null {
  if (override && existsSync(override)) return override

  // `which` via a login shell so the user's real PATH is consulted
  try {
    const out = execFileSync('/bin/zsh', ['-ilc', `which ${name}`], {
      encoding: 'utf8',
      timeout: 5000
    }).trim()
    const candidate = out.split('\n').pop()
    if (candidate && existsSync(candidate)) return candidate
  } catch {
    // fall through to manual search
  }

  const home = homedir()
  const candidates: string[] = [
    join(home, '.local', 'bin', name),
    join(home, '.claude', 'local', name),
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name
  ]

  // nvm-managed node installs
  const nvmVersions = join(home, '.nvm', 'versions', 'node')
  if (existsSync(nvmVersions)) {
    try {
      for (const v of readdirSync(nvmVersions)) {
        candidates.push(join(nvmVersions, v, 'bin', name))
      }
    } catch {
      // unreadable nvm dir — ignore
    }
  }

  return candidates.find((c) => existsSync(c)) ?? null
}
