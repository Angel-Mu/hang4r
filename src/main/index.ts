import { app, shell, BrowserWindow, ipcMain, Menu, protocol } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc, getPtyService, getBrowserControl } from './ipc'
import { Store } from './services/store'
import { SettingsService } from './services/settingsService'
import { UpdateService } from './services/updateService'
import type { SessionManager } from './services/sessionManager'

/** e2e/probe runs set this to keep automation from stealing focus */
const QUIET_TEST_MODE = process.env.HANG4R_QUIET_TEST === '1'

// A stray rejection/exception in a background service (an agent stream, a git
// shell-out, a resync) must not take the whole main process down silently —
// log a breadcrumb and keep the app alive so the user never loses a session to it.
process.on('unhandledRejection', (reason) => {
  console.error('[hang4r] unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[hang4r] uncaughtException:', err)
})

let sessionManager: SessionManager | null = null
let store: Store | null = null
/** set once the user confirms "Quit" on the live-work dialog, so the re-fired app.quit() skips the guard */
let quitConfirmed = false

// NOTE: in `npm run dev` the macOS menu-bar title still reads "Electron" —
// that string comes from the Electron binary's Info.plist and cannot be
// changed at runtime; packaged builds (productName: hang4r) show "hang4r".
app.setName('hang4r')

// HTML preview scheme (editor Preview tab): standard+secure so relative asset
// URLs resolve and fetch works inside the preview webview. Must be registered
// before app ready; the handler lives in ipc.ts on the preview partition.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hang4r-preview',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function createWindow(): void {
  // restore the last window geometry (internal UI state → SQLite, never settings.json)
  let saved: {
    x?: number
    y?: number
    width?: number
    height?: number
    maximized?: boolean
    fullscreen?: boolean
  } | null = null
  try {
    const raw = store?.getSetting('windowBounds')
    if (raw) saved = JSON.parse(raw)
  } catch {
    saved = null
  }

  const mainWindow = new BrowserWindow({
    // shown in the Window menu / Mission Control (the title BAR is hidden) —
    // without this + the renderer <title>, macOS listed the window as "Electron"
    title: 'hang4r',
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    // quiet test mode: park the window far OFFSCREEN — automated runs must not
    // appear over the user's work at all (they also never take focus below)
    ...(QUIET_TEST_MODE ? { x: 6000, y: 6000 } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#0e0f13',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // the in-tile embedded browser pane uses <webview>
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    // Quiet mode (e2e/probes): show WITHOUT activating the app, so automated
    // runs never steal keyboard focus from whatever Angel is doing.
    if (QUIET_TEST_MODE) mainWindow.showInactive()
    else {
      // re-enter the state the user last closed in (green-button fullscreen
      // and plain maximize are different states on macOS — restore either)
      if (saved?.fullscreen) mainWindow.setFullScreen(true)
      else if (saved?.maximized) mainWindow.maximize()
      mainWindow.show()
    }
  })

  // remember geometry across restarts (debounced; getNormalBounds keeps the
  // un-maximized rect so leaving fullscreen later lands on the right size)
  let boundsTimer: NodeJS.Timeout | null = null
  const saveBounds = (): void => {
    if (QUIET_TEST_MODE) return
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      try {
        store?.setSetting(
          'windowBounds',
          JSON.stringify({
            ...mainWindow.getNormalBounds(),
            maximized: mainWindow.isMaximized(),
            fullscreen: mainWindow.isFullScreen()
          })
        )
      } catch {
        /* window mid-close — keep the previous snapshot */
      }
    }, 300)
  }
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    mainWindow.on(ev as 'resize', saveBounds)
  }

  if (QUIET_TEST_MODE) {
    // macOS re-clamps an offscreen window back onto the display on renderer
    // reload (a standard e2e step), leaving a ~40×32px live sliver in the
    // screen corner — and setPosition() back offscreen is refused for visible
    // windows. So make the window fully transparent and click-through instead:
    // CDP (Playwright) input and screenshots bypass both, so tests still work.
    mainWindow.setOpacity(0)
    mainWindow.setIgnoreMouseEvents(true)
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // NOTHING may navigate the app window away — a single unguarded <a href>
  // (e.g. in rendered markdown) otherwise replaces the entire UI with the
  // link target: black window, no way back (Angel hit this live). External
  // links open in the OS browser instead; the renderer routes its own links.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // A reload navigates to the CURRENT url — allow it. This guard was
    // preventDefault-ing EVERY navigation, so Reload Window (menu + palette
    // location.reload) silently did nothing (Angel hit this). Only intercept
    // attempts to leave for a different page → open externally instead.
    if (url === mainWindow.webContents.getURL()) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.hang4r')

  // Quiet mode: run as a macOS "accessory" app — no Dock presence, no space
  // switching, no focus stealing. Playwright drives via CDP, which needs no
  // OS focus, so the whole e2e suite runs without touching the foreground.
  if (QUIET_TEST_MODE && process.platform === 'darwin') {
    try {
      app.setActivationPolicy('accessory')
      app.dock?.hide()
    } catch {
      /* non-fatal */
    }
  }

  // Dock/taskbar icon (dev mode — packaged uses build/icon.icns)
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(icon)
    } catch {
      // icon load failure is non-fatal
    }
  }

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        // NOT { role: 'fileMenu' }: that role binds Close Window to ⌘W, and a
        // menu accelerator fires even when focus is inside a <webview> — so
        // ⌘W in the browser pane closed the ENTIRE app window (Angel hit it).
        // The renderer owns ⌘W (scoped close); the window keeps ⇧⌘W.
        { label: 'File', submenu: [{ role: 'close', accelerator: 'Shift+Cmd+W' }] },
        { role: 'editMenu' },
        // NOT { role: 'viewMenu' }, and NO ⌘R / ⌥⌘I / ⌘± here. A menu
        // accelerator fires GLOBALLY — even inside a <webview> — so any browser
        // shortcut placed here would hijack the whole app (Angel hit ⌘R
        // reloading everything, and ⌥⌘I opening the APP's devtools instead of
        // the page's). Reload / DevTools / zoom belong to the browser pane and
        // are handled there per focused tab. This menu keeps only genuinely
        // app-level actions on accelerators that don't collide with the pane.
        {
          label: 'View',
          submenu: [
            // App-window reload lives on ⌥-shifted keys so plain ⌘R / ⇧⌘R stay
            // free for the browser pane's PAGE reload. These are menu items (so
            // they're discoverable) with non-conflicting accelerators.
            {
              label: 'Reload Window',
              accelerator: 'Alt+Cmd+R',
              click: () => BrowserWindow.getFocusedWindow()?.webContents.reload()
            },
            {
              label: 'Force Reload Window',
              accelerator: 'Alt+Shift+Cmd+R',
              click: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache()
            },
            {
              // DevTools on a NON-conflicting accelerator (plain ⌥⌘I belongs to
              // the browser pane's page inspector) so the renderer console is
              // reachable in the packaged app for diagnosing issues.
              label: 'Toggle Developer Tools',
              accelerator: 'Alt+Shift+Cmd+I',
              click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools()
            },
            { type: 'separator' },
            { role: 'togglefullscreen' }
          ]
        },
        { role: 'windowMenu' }
      ])
    )
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  store = new Store(join(app.getPath('userData'), 'hang4r.db'))
  // App-global settings live in ~/.hang4r; under e2e (HANG4R_USER_DATA_DIR set)
  // we nest them inside the throwaway userData dir so runs stay hermetic and
  // never touch the real home directory.
  const appConfigDir = process.env.HANG4R_USER_DATA_DIR
    ? join(process.env.HANG4R_USER_DATA_DIR, '.hang4r')
    : join(homedir(), '.hang4r')
  const settings = new SettingsService(store, appConfigDir, (scope) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings-changed', scope)
    }
  })
  sessionManager = registerIpc(store, settings)
  UpdateService.init()
  UpdateService.armAutoCheck()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// e2e probes can exercise the quit dialog even in quiet mode
const FORCE_QUIT_GUARD = process.env.HANG4R_TEST_QUIT_GUARD === '1'

// the renderer's Cursor-style quit dialog answers here
ipcMain.handle('quit:answer', (_e, quit: boolean) => {
  if (quit) {
    quitConfirmed = true
    app.quit()
  }
})

app.on('before-quit', (event) => {
  // automated runs (e2e/probes) must quit unattended — a modal confirm would
  // wedge app.close() until a human clicks it
  if (!quitConfirmed && (!QUIET_TEST_MODE || FORCE_QUIT_GUARD)) {
    const runningSessions =
      store?.listSessions().filter((s) => s.status === 'running' || s.status === 'starting')
        .length ?? 0
    // idle shell prompts don't block quit — only terminals with a real
    // foreground process (npm, vim, a build…) are worth interrupting for
    const busy = getPtyService()?.busyCount() ?? { count: 0, names: [] }
    const liveProcesses = busy.count

    if (runningSessions > 0 || liveProcesses > 0) {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.webContents.isDestroyed()) {
        // no UI to ask in — don't trap the user in an unquittable app
        quitConfirmed = true
      } else {
        event.preventDefault()
        // only mention what's actually live, with real plurals
        const parts: string[] = []
        if (runningSessions > 0)
          parts.push(
            runningSessions === 1 ? 'An agent is still working' : `${runningSessions} agents are still working`
          )
        if (liveProcesses > 0)
          parts.push(
            liveProcesses === 1
              ? `a terminal is still running ${busy.names[0]}`
              : `${liveProcesses} terminals are still running (${busy.names.join(', ')})`
          )
        const detail = [
          runningSessions > 0
            ? 'Agents stop now and pick up right where they left off when you reopen their session.'
            : '',
          liveProcesses > 0 ? 'Those processes will be killed.' : ''
        ]
          .filter(Boolean)
          .join(' ')
        // Cursor-style IN-APP dialog (the native warning box can't be styled)
        win.show()
        win.webContents.send('quit:confirm', { message: parts.join(' and ') + '.', detail })
        return
      }
    }
  }

  sessionManager?.disposeAll()
  getPtyService()?.disposeAll()
  getBrowserControl()?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
