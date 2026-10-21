import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { CliInstallResult } from '../../shared/protocol'

/** where the installed app lives when the one we were started from has moved or vanished */
export const FALLBACK_APP = '/Applications/hang4r.app'

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The `hang4r` shim, rewritten on every boot with the running app's paths. It
 * checks that the electron binary and CLI script still exist (an update or a
 * move leaves the old paths dangling) and falls back to /Applications/hang4r.app
 * before giving up with a readable error instead of "No such file".
 */
export function shimScript(
  electronPath: string,
  cliPath: string,
  fallbackApp = FALLBACK_APP
): string {
  const fallbackElectron = join(fallbackApp, 'Contents', 'MacOS', 'hang4r')
  const fallbackCli = join(fallbackApp, 'Contents', 'Resources', 'ctl', 'hang4r-cli.js')
  return `#!/bin/sh
ELECTRON=${shq(electronPath)}
CLI=${shq(cliPath)}
if [ ! -x "$ELECTRON" ] || [ ! -f "$CLI" ]; then
  ELECTRON=${shq(fallbackElectron)}
  CLI=${shq(fallbackCli)}
fi
if [ ! -x "$ELECTRON" ] || [ ! -f "$CLI" ]; then
  echo "hang4r: can't find the hang4r app (looked in ${fallbackApp.replace(/["$`\\]/g, '')}). Reinstall it, then start it once." >&2
  exit 10
fi
ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$CLI" "$@"
`
}

export function writeShim(binDir: string, electronPath: string, cliPath: string): void {
  rmSync(binDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })
  const shim = join(binDir, 'hang4r')
  writeFileSync(shim, shimScript(electronPath, cliPath), { mode: 0o755 })
  chmodSync(shim, 0o755)
}

/** PATH as the user's login shell sees it: an Electron app launched from Finder has a bare PATH. */
export function loginShellPath(): Promise<string> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-ilc', 'printenv PATH'], { timeout: 4000 }, (err, stdout) => {
      const out = String(stdout ?? '').trim().split('\n').pop() ?? ''
      resolve(err || !out ? (process.env.PATH ?? '') : out)
    })
  })
}

interface InstallOpts {
  /** <userData>/bin/hang4r — what the link must point at */
  shimPath: string
  /** the running app's executable; AppTranslocation shows up here */
  appPath: string
  home?: string
  /** the user's PATH; defaults to asking the login shell */
  pathValue?: () => Promise<string>
}

function linkLocation(home: string): { dir: string; link: string } {
  const dir = join(home, '.local', 'bin')
  return { dir, link: join(dir, 'hang4r') }
}

function isDanglingLink(link: string): boolean {
  try {
    lstatSync(link)
    return true
  } catch {
    return false
  }
}

function isOurLink(link: string, shimPath: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && readlinkSync(link) === shimPath
  } catch {
    return false
  }
}

async function pathReport(
  dir: string,
  pathValue?: () => Promise<string>
): Promise<Pick<CliInstallResult, 'onPath' | 'pathLine'>> {
  const value = await (pathValue ?? loginShellPath)()
  const onPath = value.split(delimiter).includes(dir)
  return { onPath, pathLine: onPath ? null : 'export PATH="$HOME/.local/bin:$PATH"' }
}

/**
 * Symlink ~/.local/bin/hang4r -> the userData shim. No sudo and no /usr/local/bin.
 * Replaces nothing it did not create: an existing file, directory or foreign
 * symlink at that path is left alone and reported.
 */
export async function installCli(opts: InstallOpts): Promise<CliInstallResult> {
  const { dir, link } = linkLocation(opts.home ?? homedir())
  const base = { linkPath: link, target: opts.shimPath }
  if (opts.appPath.includes('AppTranslocation')) {
    // a quarantined app runs from a random read-only mount that disappears on
    // relaunch, so a link to it would break the next time hang4r starts
    return {
      ...base,
      ok: false,
      reason: 'translocated',
      message:
        'hang4r is running from a temporary location. Move it to /Applications, open it from there, then install the command.',
      onPath: false,
      pathLine: null
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    let exists = false
    try {
      lstatSync(link)
      exists = true
    } catch {
      /* nothing there */
    }
    if (exists && !isOurLink(link, opts.shimPath)) {
      return {
        ...base,
        ok: false,
        reason: 'exists',
        message: `${link} already exists and is not the hang4r command. Remove it yourself if you want to replace it.`,
        ...(await pathReport(dir, opts.pathValue))
      }
    }
    if (!exists) symlinkSync(opts.shimPath, link)
    const path = await pathReport(dir, opts.pathValue)
    return {
      ...base,
      ok: true,
      message: path.onPath
        ? `Installed ${link}.`
        : `Installed ${link}, but ${dir} is not on your PATH. Add this to your shell profile: ${path.pathLine}`,
      ...path
    }
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
      onPath: false,
      pathLine: null
    }
  }
}

/** Remove the link, but only if it is the one installCli made. */
export async function uninstallCli(opts: InstallOpts): Promise<CliInstallResult> {
  const { dir, link } = linkLocation(opts.home ?? homedir())
  const base = { linkPath: link, target: opts.shimPath }
  const path = await pathReport(dir, opts.pathValue)
  if (!isOurLink(link, opts.shimPath)) {
    const present = existsSync(link) || isDanglingLink(link)
    return {
      ...base,
      ok: !present,
      reason: present ? 'exists' : undefined,
      message: present
        ? `${link} is not a link to this hang4r, so it was left alone.`
        : 'The command was not installed.',
      ...path
    }
  }
  rmSync(link)
  return { ...base, ok: true, message: `Removed ${link}.`, ...path }
}
