import { app, shell, BrowserWindow, ipcMain, Menu, protocol } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc, getPtyService, getBrowserControl, getBridge } from './ipc'
import { askInterrupt, guardActive, initInterruptGuard, liveWork, resolveInterrupt } from './interruptGuard'
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
      webviewTag: true,
      // Chromium's built-in PDF viewer (PDFium) — without this, the editor's
      // <embed type="application/pdf"> just spins on a blank tab (Angel: "IDE
      // cannot preview pdf files"). No Flash/NPAPI risk; this is the PDF plugin.
      plugins: true,
      // hang4r is an agent MONITOR — keep the renderer live while backgrounded so
      // a turn that completes while you're in another app still commits to the
      // conversation. Default throttling deferred the React commit, so you'd get
      // a notification, come back, and see NOTHING until an unrelated action
      // (opening Settings, switching sessions) forced a flush (Angel).
      backgroundThrottling: false
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
    // A hang4r-native menu bar (Cursor-shaped), not Electron's defaults. Every
    // app action is exposed + discoverable with its shortcut. CRITICAL: menu
    // accelerators fire GLOBALLY — even inside the <webview> browser pane — so
    // for anything the RENDERER already owns (⌘P/⌘K/⌘B/⌘F/…, all focus-aware),
    // we set `registerAccelerator: false`: the shortcut is DISPLAYED but NOT
    // registered, so the renderer keeps handling the key (no browser-pane
    // hijack) while CLICKING the item still works via `menu:command`. Only
    // menu-native actions (reload/devtools/close-window) keep real accelerators,
    // on ⌥-shifted keys that don't collide with the browser pane.
    const run = (cmd: string): void =>
      BrowserWindow.getFocusedWindow()?.webContents.send('menu:command', cmd)
    /** renderer-owned shortcut: show it, don't bind it, route clicks to the renderer */
    const cmd = (
      label: string,
      accelerator: string,
      command: string
    ): Electron.MenuItemConstructorOptions => ({
      label,
      accelerator,
      registerAccelerator: false,
      click: () => run(command)
    })
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'hang4r',
          submenu: [
            { role: 'about', label: 'About hang4r' },
            { label: 'Check for Updates…', click: () => run('check-updates') },
            { type: 'separator' },
            cmd('Settings…', 'Cmd+,', 'settings'),
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide', label: 'Hide hang4r' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: 'Quit hang4r' }
          ]
        },
        {
          label: 'File',
          submenu: [
            cmd('New Agent', 'Cmd+N', 'new-agent'),
            { label: 'New Workspace…', click: () => run('new-workspace') },
            { label: 'Import a Session…', click: () => run('import-session') },
            { type: 'separator' },
            // ⌘W is the renderer's SCOPED close (editor file / terminal / pane);
            // ⇧⌘W closes the whole window. (fileMenu role's ⌘W would fire even in
            // the webview and close the whole app — Angel hit that.)
            cmd('Close Pane', 'Cmd+W', 'close'),
            { role: 'close', label: 'Close Window', accelerator: 'Shift+Cmd+W' }
          ]
        },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            cmd('Command Palette…', 'Shift+Cmd+P', 'command-palette'),
            cmd('Quick Open File…', 'Cmd+P', 'quick-open'),
            cmd('Search in Files…', 'Shift+Cmd+F', 'search-files'),
            { type: 'separator' },
            cmd('Toggle Sidebar', 'Cmd+B', 'toggle-sidebar'),
            cmd('Toggle Context Panel', 'Alt+Cmd+B', 'toggle-panel'),
            cmd('Toggle Terminal', 'Ctrl+`', 'toggle-terminal'),
            { type: 'separator' },
            // real accelerators — menu-native, ⌥-shifted so plain ⌘R / ⌥⌘I stay
            // free for the browser pane's own page reload / inspector
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
              label: 'Toggle Developer Tools',
              accelerator: 'Alt+Shift+Cmd+I',
              click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools()
            },
            { type: 'separator' },
            { role: 'togglefullscreen' }
          ]
        },
        {
          label: 'Session',
          submenu: [
            cmd('Interrupt Agent', 'Cmd+.', 'interrupt'),
            cmd('Expand / Collapse Pane', 'Shift+Cmd+E', 'expand-pane')
          ]
        },
        { role: 'windowMenu' },
        {
          role: 'help',
          submenu: [
            { label: 'hang4r Website', click: () => void shell.openExternal('https://hang4r.dev') },
            {
              label: 'Release Notes',
              click: () =>
                void shell.openExternal('https://github.com/Angel-Mu/hang4r-releases/releases')
            },
            {
              label: 'Report an Issue',
              click: () => void shell.openExternal('https://github.com/Angel-Mu/hang4r/issues')
            }
          ]
        }
      ])
    )
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    // Reliable DevTools toggle for the packaged app. The ⌥⇧⌘I menu accelerator
    // didn't fire for Angel because Option turns "I" into a dead key (ˆ), so it
    // never matched. Match the PHYSICAL key (input.code === 'KeyI'), which Option
    // can't mangle. (No F12 — the browser pane owns that for the webview.)
    window.webContents.on('before-input-event', (_e, input) => {
      if (
        input.type === 'keyDown' &&
        input.meta &&
        input.shift &&
        input.alt &&
        !input.control &&
        input.code === 'KeyI'
      ) {
        window.webContents.toggleDevTools()
      }
    })
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
  initInterruptGuard({
    runningSessions: () =>
      store?.listSessions().filter((s) => s.status === 'running' || s.status === 'starting')
        .length ?? 0,
    busyProcesses: () => getPtyService()?.busyCount() ?? { count: 0, names: [] },
    detachedProcesses: () => getPtyService()?.detached() ?? { count: 0, names: [] },
    backgroundTasks: () =>
      sessionManager?.runningBackgroundTasks() ?? Promise.resolve({ count: 0, names: [] })
  })
  UpdateService.init()
  UpdateService.armAutoCheck()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// the renderer's Cursor-style quit dialog answers here — it also answers the
// update-restart confirm, which is why the answer goes to the guard first
ipcMain.handle('quit:answer', (_e, quit: boolean) => {
  if (resolveInterrupt(quit) || !quit) return
  // answering yes with no confirm on screen pre-authorizes the quit — e2e
  // teardown does this to tear down an app whose guard is armed
  quitConfirmed = true
  app.quit()
})

app.on('before-quit', (event) => {
  if (!quitConfirmed && guardActive()) {
    // liveWork() has to lsof the background-task logs, so the answer can't be
    // had synchronously: hold the quit, then either re-quit or ask. The re-quit
    // sets quitConfirmed first, so this branch can't loop.
    event.preventDefault()
    void liveWork().then(async (work) => {
      if (work && !(await askInterrupt('quit', work))) return
      quitConfirmed = true
      app.quit()
    })
    return
  }

  try {
    sessionManager?.disposeAll()
    getPtyService()?.disposeAll()
    getBrowserControl()?.dispose()
    getBridge()?.dispose()
  } catch {
    // best-effort — we're terminating regardless; a disposal error must not
    // fall through to the graceful teardown that crashes (below)
  }

  // "hang4r quit unexpectedly" (SIGABRT) crash on close/reinstall. Stack:
  // node::Environment::CleanupHandles → uv_run → node::ThreadPoolWork (node-pty's
  // waitpid completion) → pty.node ThreadSafeFunction::CallJS →
  // ThrowAsJavaScriptException → abort. When we kill the PTYs above, node-pty has
  // an in-flight libuv work item to reap the child; Node's graceful shutdown runs
  // a FINAL uv_run inside CleanupHandles that drains it, firing node-pty's onExit
  // ThreadSafeFunction into a JS context that's already being freed → it throws
  // during teardown → abort.
  //
  // app.exit(0) was NOT enough (v1.0.51): Electron's exit still runs
  // FreeEnvironment → CleanupHandles → that fatal uv_run. The only reliable fix
  // is to skip Node/libuv cleanup ENTIRELY — SIGKILL is uncatchable and
  // terminates the process instantly, so the pty callback never runs. Safe: the
  // PTYs are already killed, better-sqlite3 commits synchronously (WAL is
  // crash-safe, replays on next open — no data loss), and Squirrel's installer
  // only needs the process to EXIT for an in-app update to apply (it does, even
  // through the old crash). Not under e2e — Playwright owns the quit there and a
  // hard kill would break its teardown/coverage.
  if (!QUIET_TEST_MODE) {
    try {
      process.kill(process.pid, 'SIGKILL')
    } catch {
      app.exit(0) // SIGKILL never returns; this is a paranoid fallback only
    }
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
