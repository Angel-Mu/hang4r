import { app, BrowserWindow } from 'electron'
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

export const UpdateService = {
  /** attach listeners once; safe in dev (no feed) — checks just report status */
  init(): void {
    if (wired) return
    wired = true
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
