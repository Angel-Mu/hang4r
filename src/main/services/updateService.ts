import { app, BrowserWindow } from 'electron'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import updater from 'electron-updater'
import type { UpdateStatus } from '../../shared/protocol'

const { autoUpdater } = updater

/**
 * Auto-update via electron-updater against the GitHub Releases feed (configured
 * in electron-builder.yml → publish). Manual-check model: we never auto-download;
 * the user triggers a check, then chooses to download + install. Status flows to
 * the renderer on the 'update-status' channel. A real update needs a published,
 * signed release — in dev / unsigned builds a check reports a clear status
 * instead of crashing.
 */
let wired = false
let last: UpdateStatus = { state: 'idle' }

function broadcast(status: UpdateStatus): void {
  last = status
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update-status', status)
  }
}

/**
 * Delete installers left behind by updates that have already been applied.
 *
 * electron-updater keeps its download in `<cache>/hang4r-updater` and never
 * removes it once installed, so the cache holds a full copy of the app forever —
 * Angel found 335MB of it after a run of releases, and hit a disk-full warning.
 * A user who takes twenty updates should not be storing twenty of them.
 *
 * Runs once at startup, BEFORE any check or download is wired: a file staged for
 * a version NEWER than the one running is about to be installed on quit and is
 * left alone; everything else describes an update already taken.
 */
function pruneStaleDownloads(): void {
  // electron-updater's own cache location, verified on disk rather than guessed:
  // ~/Library/Caches/hang4r-updater on macOS
  const name = `${app.getName()}-updater`
  const dir =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Caches', name)
      : platform() === 'win32'
        ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), name)
        : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), name)
  const current = app.getVersion()
  // "hang4r-1.0.134-arm64-mac.zip" → 1.0.134
  const versionOf = (name: string): string | null =>
    /-(\d+\.\d+\.\d+)-/.exec(name)?.[1] ?? null
  const newerThanCurrent = (v: string): boolean => {
    const a = v.split('.').map(Number)
    const b = current.split('.').map(Number)
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
    return false
  }
  const prune = (folder: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(folder)
    } catch {
      return // no cache yet — nothing to clean
    }
    for (const name of entries) {
      const full = join(folder, name)
      try {
        if (statSync(full).isDirectory()) {
          if (name === 'pending') prune(full)
          continue
        }
        if (!/\.(zip|dmg|blockmap)$/i.test(name)) continue
        const v = versionOf(name)
        // an unversioned staging copy (update.zip) is a leftover of an applied
        // update; a versioned one is only worth keeping if it is still ahead
        if (v && newerThanCurrent(v)) continue
        rmSync(full, { force: true })
      } catch {
        /* in use or already gone — leave it */
      }
    }
  }
  prune(dir)
}

export const UpdateService = {
  /** attach listeners once; safe in dev (no feed) — checks just report status */
  init(): void {
    if (wired) return
    wired = true
    // before anything can start downloading, so an in-flight download is never
    // the thing being deleted
    try {
      pruneStaleDownloads()
    } catch {
      /* housekeeping must never keep the app from starting */
    }
    // Auto-DOWNLOAD once an update is found (silent, background — nothing
    // closes) and stage it to install on the next natural quit. The user is
    // never interrupted: no auto-restart. A visible in-app pill offers
    // "Restart" for whoever wants it now. (Angel's rule is that WE never close
    // his running app — a background download + install-on-quit honors that.)
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      broadcast({ state: 'available', version: info.version })
    )
    autoUpdater.on('update-not-available', (info) =>
      broadcast({ state: 'not-available', version: info.version })
    )
    autoUpdater.on('download-progress', (p) =>
      broadcast({ state: 'downloading', percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) =>
      broadcast({ state: 'downloaded', version: info.version })
    )
    autoUpdater.on('error', (err) =>
      broadcast({ state: 'error', message: err?.message ?? String(err) })
    )
  },

  status(): UpdateStatus {
    return last
  },

  /** Fire a silent check shortly after boot, then every 6h, so the app
   *  discovers updates on its own instead of waiting for a manual Settings
   *  visit (Angel: "why it cannot update my app?" — it never looked). Packaged
   *  only; check() no-ops safely in dev. */
  armAutoCheck(): void {
    if (!app.isPackaged) return
    const tick = (): void => void this.check().catch(() => {})
    setTimeout(tick, 8_000)
    setInterval(tick, 6 * 60 * 60 * 1000)
  },

  async check(): Promise<UpdateStatus> {
    // In an unpackaged dev build there's no app-update.yml, so a check would
    // throw — report that cleanly rather than crashing.
    if (!app.isPackaged) {
      const s: UpdateStatus = {
        state: 'error',
        message: 'Updates are only checked in the packaged app.'
      }
      broadcast(s)
      return s
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return last
  },

  async download(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  },

  install(): void {
    autoUpdater.quitAndInstall()
  }
}
