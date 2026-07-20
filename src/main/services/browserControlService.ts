import { app, webContents, type WebContents } from 'electron'
import { createServer, type Server, type Socket } from 'node:net'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserGuestReport, BrowserHotkeyAction } from '../../shared/protocol'

/** one captured console message from a guest page (ring-buffered per tab) */
interface ConsoleEntry {
  level: string
  message: string
  ts: number
}

/** a live browser tab the renderer registered for a session */
interface GuestEntry {
  tabId: string
  wcId: number
  url: string
  title: string
  active: boolean
  console: ConsoleEntry[]
  /** detach the console-message + destroyed listeners */
  cleanup: () => void
}

const CONSOLE_RING = 200
const OUTPUT_CAP = 40_000
const ENSURE_TAB_TIMEOUT_MS = 10_000
const LOAD_TIMEOUT_MS = 30_000

/** ⌘←/⌘→ history nav runs IN the page: only there can we tell whether focus
 *  is on an editable element, where the caret jump must win over navigation. */
const NAV_KEYS_SNIPPET = `(() => {
  if (window.__hang4rNavKeys) return
  window.__hang4rNavKeys = true
  const editable = (el) =>
    !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
  window.addEventListener('keydown', (e) => {
    if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (editable(document.activeElement)) return
    e.preventDefault()
    if (e.key === 'ArrowLeft') history.back()
    else history.forward()
  }, true)
})()`

/**
 * Main-process control plane for the agent-drivable browser (the `hang4r browser`
 * CLI). Listens on a unix socket in userData; every request carries a boot token.
 * The renderer registers each session's live browser tabs (webContentsId + url +
 * title + active) over IPC; commands here resolve a tab's guest webContents and
 * drive it (navigate, snapshot the DOM, click/type via injected JS, screenshot,
 * read the captured console). One command per connection, newline-delimited JSON.
 */
export class BrowserControlService {
  readonly sockPath: string
  readonly tokenPath: string
  readonly binDir: string
  readonly cliPath: string
  private readonly token = randomUUID()
  private server: Server | null = null
  /** sessionId -> tabId -> guest */
  private guests = new Map<string, Map<string, GuestEntry>>()

  constructor(
    userData: string,
    /** ask the renderer to open/navigate a Browser tab for a session (main→renderer) */
    private readonly ensureTab: (sessionId: string, url: string) => void,
    /** forward a guest-focused browser hotkey to the renderer's pane UI */
    private readonly hotkey: (sessionId: string, tabId: string, action: BrowserHotkeyAction) => void,
    /** a link the guest page tried to open in a NEW window (cmd+click /
     *  target=_blank) → open it in a new in-pane tab, never a separate OS window */
    private readonly openInTab: (sessionId: string, url: string) => void
  ) {
    this.sockPath = join(userData, 'ctl.sock')
    this.tokenPath = join(userData, 'ctl.token')
    this.binDir = join(userData, 'bin')
    // dev/e2e run the built app (out/main/index.js) from the repo root; packaged
    // builds ship the CLI under Resources/ctl (electron-builder extraResources)
    this.cliPath = app.isPackaged
      ? join(process.resourcesPath, 'ctl', 'hang4r-cli.js')
      : join(__dirname, '../../resources/ctl/hang4r-cli.js')
  }

  /** bind the socket, write the token file + `hang4r` bin shim. Call after app ready. */
  start(): void {
    // unlink a stale socket from a previous run (a crashed process leaves it)
    try {
      if (existsSync(this.sockPath)) unlinkSync(this.sockPath)
    } catch {
      /* best-effort */
    }
    this.server = createServer((socket) => this.onConnection(socket))
    this.server.on('error', (err) => {
      console.error('[browserControl] socket server error:', err)
    })
    this.server.listen(this.sockPath, () => {
      try {
        chmodSync(this.sockPath, 0o600)
      } catch {
        /* non-fatal */
      }
    })
    this.writeToken()
    this.writeBinShim()
  }

  /** env vars every per-session process gets so the CLI can find + auth the socket */
  sessionEnv(sessionId: string): Record<string, string> {
    return {
      HANG4R_CTL_SOCK: this.sockPath,
      HANG4R_CTL_TOKEN: this.token,
      HANG4R_SESSION_ID: sessionId,
      // absolute path to the `hang4r` shim — a robust fallback the agent can call
      // when a login shell rebuilds PATH and drops our prepend (so `command -v
      // hang4r` comes back empty even though we injected the dir below)
      HANG4R_CLI: join(this.binDir, 'hang4r'),
      // prepend our bin dir so `hang4r` resolves on PATH
      PATH: `${this.binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
    }
  }

  /** renderer reports the full tab list for a session on any browser-pane change */
  registerGuests(report: BrowserGuestReport): void {
    const { sessionId, tabs } = report
    const prev = this.guests.get(sessionId) ?? new Map<string, GuestEntry>()
    const next = new Map<string, GuestEntry>()
    const seen = new Set(tabs.map((t) => t.tabId))
    // drop tabs the renderer no longer reports (closed / pane unmounted)
    for (const [tabId, entry] of prev) if (!seen.has(tabId)) entry.cleanup()
    for (const t of tabs) {
      const old = prev.get(t.tabId)
      if (old && old.wcId === t.webContentsId) {
        // same tab + same webContents — keep its console buffer & listeners
        old.url = t.url
        old.title = t.title
        old.active = t.active
        next.set(t.tabId, old)
      } else {
        old?.cleanup()
        const entry: GuestEntry = {
          tabId: t.tabId,
          wcId: t.webContentsId,
          url: t.url,
          title: t.title,
          active: t.active,
          console: [],
          cleanup: () => {}
        }
        this.attachConsole(entry)
        this.attachHotkeys(entry, sessionId)
        next.set(t.tabId, entry)
      }
    }
    if (next.size) this.guests.set(sessionId, next)
    else this.guests.delete(sessionId)
  }

  dispose(): void {
    for (const map of this.guests.values()) for (const e of map.values()) e.cleanup()
    this.guests.clear()
    this.server?.close()
    this.server = null
    try {
      if (existsSync(this.sockPath)) unlinkSync(this.sockPath)
    } catch {
      /* best-effort */
    }
  }

  /* ---------------- socket plumbing ---------------- */

  private onConnection(socket: Socket): void {
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl)
      buf = ''
      void this.handleLine(line)
        .then((result) => socket.end(JSON.stringify({ ok: true, result }) + '\n'))
        .catch((err: unknown) =>
          socket.end(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) +
              '\n'
          )
        )
    })
    socket.on('error', () => socket.destroy())
  }

  private async handleLine(line: string): Promise<unknown> {
    let req: { token?: string; sessionId?: string; cmd?: string; args?: Record<string, unknown> }
    try {
      req = JSON.parse(line)
    } catch {
      throw new Error('Malformed request (expected one JSON line).')
    }
    if (req.token !== this.token) throw new Error('Unauthorized: bad or missing token.')
    if (!req.sessionId) throw new Error('Missing sessionId.')
    if (!req.cmd) throw new Error('Missing cmd.')
    return this.dispatch(req.sessionId, req.cmd, req.args ?? {})
  }

  /* ---------------- guest resolution ---------------- */

  private guestFor(sessionId: string, tabId?: string): GuestEntry {
    const map = this.guests.get(sessionId)
    if (!map || map.size === 0) {
      throw new Error(
        'This session has no browser tab open — run `hang4r browser goto <url>` first (or open the session\'s Browser tab in hang4r).'
      )
    }
    if (tabId) {
      const entry = map.get(tabId)
      if (!entry) throw new Error(`No tab with id ${tabId} in this session — run \`hang4r browser tabs\`.`)
      return entry
    }
    // default to the active tab, else the first
    for (const e of map.values()) if (e.active) return e
    return map.values().next().value as GuestEntry
  }

  private liveWc(entry: GuestEntry): WebContents {
    const wc = webContents.fromId(entry.wcId)
    if (!wc || wc.isDestroyed()) {
      throw new Error('That browser tab is gone (its webview was closed) — run `hang4r browser tabs`.')
    }
    return wc
  }

  /* ---------------- console capture ---------------- */

  private attachConsole(entry: GuestEntry): void {
    const wc = webContents.fromId(entry.wcId)
    if (!wc || wc.isDestroyed()) return
    // Electron 39 delivers a single event object: { level: 'info'|'warning'|
    // 'error'|'debug', message }. (The positional-args overload is deprecated.)
    const onMsg = (details: { level: string; message: string }): void => {
      entry.console.push({ level: details.level, message: details.message, ts: Date.now() })
      if (entry.console.length > CONSOLE_RING) entry.console.shift()
    }
    wc.on('console-message', onMsg)
    const onDestroyed = (): void => entry.cleanup()
    wc.once('destroyed', onDestroyed)
    entry.cleanup = (): void => {
      try {
        wc.off('console-message', onMsg)
        wc.off('destroyed', onDestroyed)
      } catch {
        /* wc already gone */
      }
    }
  }

  /* ---------------- browser hotkeys (guest-focused) ---------------- */

  /** Standard browser keybindings while the PAGE has focus. Host-chrome focus
   *  (address bar etc.) is handled by BrowserPane's React handler — keystrokes
   *  inside a <webview> never reach the host DOM, so main must intercept. */
  private attachHotkeys(entry: GuestEntry, sessionId: string): void {
    const wc = webContents.fromId(entry.wcId)
    if (!wc || wc.isDestroyed()) return
    const emit = (action: BrowserHotkeyAction): void => this.hotkey(sessionId, entry.tabId, action)
    const onInput = (e: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      // F12 (no modifier) toggles devtools even when the page has focus
      if (input.key === 'F12' && !input.meta && !input.control && !input.alt) {
        e.preventDefault()
        emit('toggle-devtools')
        return
      }
      if (!input.meta || input.control) return
      if (input.alt) {
        if (key === 'i' || key === 'j') {
          e.preventDefault()
          emit('toggle-devtools')
        } else if (key === 'arrowleft') {
          e.preventDefault()
          emit('prev-tab')
        } else if (key === 'arrowright') {
          e.preventDefault()
          emit('next-tab')
        }
        return
      }
      // ⇧⌘W (close window) and friends belong to the app — only plain ⌘R has
      // a shifted variant here (hard reload), plus ⇧⌘= arriving as '+'
      if (input.shift && key !== 'r' && key !== '=' && key !== '+') return
      switch (key) {
        case 'r':
          e.preventDefault()
          if (input.shift) wc.reloadIgnoringCache()
          else wc.reload()
          return
        case 'l':
          e.preventDefault()
          emit('focus-address')
          return
        case 'f':
          e.preventDefault()
          emit('find')
          return
        case 'i':
        case 'j':
          e.preventDefault()
          emit('toggle-devtools')
          return
        case 't':
          e.preventDefault()
          emit('new-tab')
          return
        case 'w':
          e.preventDefault()
          emit('close-tab')
          return
        case '[':
          e.preventDefault()
          wc.navigationHistory.goBack()
          return
        case ']':
          e.preventDefault()
          wc.navigationHistory.goForward()
          return
        case '=':
        case '+':
          e.preventDefault()
          wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5))
          return
        case '-':
          e.preventDefault()
          wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -5))
          return
        case '0':
          e.preventDefault()
          wc.setZoomLevel(0)
          return
      }
    }
    wc.on('before-input-event', onInput)
    // A link that asks for a new window (cmd/⌘-click, target=_blank, window.open)
    // would otherwise spawn a separate OS window — Electron's default disposition
    // for a guest webContents. Deny that and hand the url to the renderer so it
    // opens a NEW in-pane tab, exactly like a real browser (Angel: "opens a whole
    // new window 🤯"). http(s) only; other schemes are dropped, not shell-opened.
    wc.setWindowOpenHandler((details) => {
      if (/^https?:\/\//i.test(details.url)) this.openInTab(sessionId, details.url)
      return { action: 'deny' }
    })
    // (Re)inject the ⌘←/→ history snippet on EVERY load path — a full navigation
    // replaces the guest window (resetting the guard), and dom-ready alone
    // sometimes fired before the page was ready to bind the listener, so ⌘←/→
    // silently did nothing (Angel). did-finish-load + did-navigate cover the gaps.
    const inject = (): void => {
      void wc.executeJavaScript(NAV_KEYS_SNIPPET).catch(() => {})
    }
    wc.on('dom-ready', inject)
    wc.on('did-finish-load', inject)
    wc.on('did-navigate', inject)
    wc.on('did-navigate-in-page', inject)
    if (!wc.isLoading()) inject()
    const prevCleanup = entry.cleanup
    entry.cleanup = (): void => {
      prevCleanup()
      try {
        wc.off('before-input-event', onInput)
        wc.off('dom-ready', inject)
        wc.off('did-finish-load', inject)
        wc.off('did-navigate', inject)
        wc.off('did-navigate-in-page', inject)
      } catch {
        /* wc already gone */
      }
    }
  }

  /* ---------------- command dispatch ---------------- */

  private async dispatch(
    sessionId: string,
    cmd: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : undefined
    switch (cmd) {
      case 'tabs':
        return this.cmdTabs(sessionId)
      case 'goto':
        return this.cmdGoto(sessionId, str(args.url, 'url'), tabId)
      case 'snapshot':
        return this.cmdSnapshot(sessionId, tabId, optStr(args.selector), Boolean(args.compact))
      case 'click':
        return this.cmdClick(sessionId, tabId, str(args.target, 'target'))
      case 'type':
        return this.cmdType(sessionId, tabId, str(args.target, 'target'), String(args.text ?? ''))
      case 'select':
        return this.cmdSelect(sessionId, tabId, str(args.target, 'target'), String(args.value ?? ''))
      case 'press':
        return this.cmdPress(sessionId, tabId, str(args.key, 'key'))
      case 'scroll':
        return this.cmdScroll(sessionId, tabId, num(args.dy), num(args.dx), optStr(args.selector))
      case 'get':
        return this.cmdGet(sessionId, tabId, str(args.what, 'what'), optStr(args.selector))
      case 'eval':
        return this.cmdEval(sessionId, tabId, str(args.js, 'js'))
      case 'wait':
        return this.cmdWait(
          sessionId,
          tabId,
          optStr(args.selector),
          optStr(args.text),
          typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
        )
      case 'screenshot':
        return this.cmdScreenshot(sessionId, tabId, optStr(args.path))
      case 'console':
        return this.cmdConsole(sessionId, tabId, Boolean(args.clear))
      default:
        throw new Error(`Unknown command: ${cmd}`)
    }
  }

  private cmdTabs(sessionId: string): { tabs: { id: string; title: string; url: string; active: boolean }[] } {
    const map = this.guests.get(sessionId)
    const tabs = map
      ? [...map.values()].map((e) => ({ id: e.tabId, title: e.title, url: e.url, active: e.active }))
      : []
    return { tabs }
  }

  private async cmdGoto(
    sessionId: string,
    url: string,
    tabId?: string
  ): Promise<{ url: string; title: string; failed?: { errorCode: number; errorDescription: string } }> {
    const map = this.guests.get(sessionId)
    let wc: WebContents
    if (!map || map.size === 0) {
      // No live browser: ask the renderer to open a Browser tab whose webview
      // src IS `url`, and wait for that guest to register + finish loading. We
      // also drive loadURL(url) from the main process as a safeguard: if the
      // hang4r window is backgrounded/occluded, Chromium throttles the guest's
      // renderer-initiated (src) navigation, and a main-process load forces it.
      // Both target the SAME url so they converge; we re-assert periodically and
      // poll the committed URL (a synchronous main-side read).
      this.ensureTab(sessionId, url)
      const overallDeadline = Date.now() + ENSURE_TAB_TIMEOUT_MS
      let lastLoad = 0
      for (;;) {
        const entry = await this.waitForGuest(sessionId, Math.max(0, overallDeadline - Date.now()))
        if (!entry) {
          throw new Error(
            "Couldn't open a browser tab for this session — open the session's Browser tab in hang4r first (the tile must be on screen)."
          )
        }
        let guestWc: WebContents | null = null
        try {
          guestWc = this.liveWc(entry)
        } catch {
          /* guest churned mid-attach — re-resolve */
        }
        if (guestWc) {
          const now = guestWc.getURL()
          if (now && now !== 'about:blank' && !guestWc.isLoadingMainFrame()) {
            return { url: now, title: guestWc.getTitle() }
          }
          if (Date.now() - lastLoad > 500) {
            guestWc.loadURL(url).catch(() => {
              /* did-fail-load reports the real reason */
            })
            lastLoad = Date.now()
          }
        }
        if (Date.now() >= overallDeadline) {
          throw new Error(`The browser tab did not finish loading ${url} in time.`)
        }
        await delay(120)
      }
    }
    wc = this.liveWc(this.guestFor(sessionId, tabId))
    const loaded = this.awaitLoad(wc)
    wc.loadURL(url).catch(() => {
      /* did-fail-load reports the real reason; swallow the promise rejection */
    })
    const failed = await loaded
    return { url: wc.getURL(), title: wc.getTitle(), ...(failed ? { failed } : {}) }
  }

  private async cmdSnapshot(
    sessionId: string,
    tabId: string | undefined,
    selector: string | undefined,
    compact: boolean
  ): Promise<{ text: string }> {
    const wc = this.liveWc(this.guestFor(sessionId, tabId))
    const text = (await wc.executeJavaScript(snapshotJs(selector, compact))) as string
    return { text }
  }

  private async cmdClick(sessionId: string, tabId: string | undefined, target: string): Promise<{ ok: true }> {
    const wc = this.liveWc(this.guestFor(sessionId, tabId))
    const res = (await wc.executeJavaScript(clickJs(target))) as InjectResult
    if (!res.ok) throw new Error(res.error)
    return { ok: true }
  }

  private async cmdType(
    sessionId: string,
    tabId: string | undefined,
    target: string,
    text: string
  ): Promise<{ ok: true }> {
    const wc = this.liveWc(this.guestFor(sessionId, tabId))
    const res = (await wc.executeJavaScript(typeJs(target, text))) as InjectResult
    if (!res.ok) throw new Error(res.error)
    return { ok: true }
  }

  private async cmdSelect(
    sessionId: string,
    tabId: string | undefined,
    target: string,
    value: string
  ): Promise<{ ok: true }> {
    const wc = this.liveWc(this.guestFor(sessionId, tabId))
    const res = (await wc.executeJavaScript(selectJs(target, value))) as InjectResult
    if (!res.ok) throw new Error(res.error)
    return { ok: true }
  }

  private async cmdPress(sessionId: string, tabId: string | undefined, key: string): Promise<{ ok: true }> {
    const wc = this.liveWc(this.guestFor(sessionId, tabId))
    const res = (await wc.executeJavaScript(pressJs(key))) as InjectResult
    if (!res.ok) throw new Error(res.error)
    return { ok: true }
  }

  private async cmdScroll(
    sessionId: string,
    tabId: string | undefined,
    dy: number,
    dx: number,
    selector: string | undefined
  ): Promise<{ ok: true }> {
    const wc = this.liveWc(this.guestFor(sessionId, tabId))
    const res = (await wc.executeJavaScript(scrollJs(dy, dx, selector))) as InjectResult
    if (!res.ok) throw new Error(res.error)
    return { ok: true }
  }

  private async cmdGet(
    sessionId: string,
    tabId: string | undefined,
    what: string,
    selector: string | undefined
  ): Promise<{ value: string }> {
    const entry = this.guestFor(sessionId, tabId)
    const wc = this.liveWc(entry)
    if (what === 'url') return { value: wc.getURL() }
    if (what === 'title') return { value: wc.getTitle() }
    if (what === 'text') {
      const value = (await wc.executeJavaScript(getTextJs(selector))) as string
      return { value }
    }
    throw new Error(`get: unknown target "${what}" (use text | url | title).`)
  }

  private async cmdEval(sessionId: string, tabId: string | undefined, js: string): Promise<{ json: string }> {
    const wc = this.liveWc(this.guestFor(sessionId, tabId))
    const res = (await wc.executeJavaScript(evalJs(js))) as { ok: boolean; json?: string; error?: string }
    if (!res.ok) throw new Error(res.error ?? 'eval failed')
    return { json: res.json ?? 'undefined' }
  }

  private async cmdWait(
    sessionId: string,
    tabId: string | undefined,
    selector: string | undefined,
    text: string | undefined,
    timeoutMs = 10_000
  ): Promise<{ matched: true; elapsedMs: number }> {
    if (!selector && !text) throw new Error('wait needs --selector or --text.')
    const entry = this.guestFor(sessionId, tabId)
    const started = Date.now()
    const deadline = started + Math.max(0, timeoutMs)
    for (;;) {
      const wc = this.liveWc(entry)
      const matched = (await wc.executeJavaScript(waitCheckJs(selector, text))) as boolean
      if (matched) return { matched: true, elapsedMs: Date.now() - started }
      if (Date.now() >= deadline) {
        const what = selector ? `selector "${selector}"` : `text "${text}"`
        throw new Error(`wait timed out after ${timeoutMs}ms waiting for ${what}.`)
      }
      await delay(250)
    }
  }

  private async cmdScreenshot(
    sessionId: string,
    tabId: string | undefined,
    outPath: string | undefined
  ): Promise<{ path: string }> {
    const wc = this.liveWc(this.guestFor(sessionId, tabId))
    const image = await wc.capturePage()
    const png = image.toPNG()
    const dest = outPath ?? join(app.getPath('temp'), 'hang4r-shots', `${Date.now()}.png`)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, png)
    return { path: dest }
  }

  private cmdConsole(
    sessionId: string,
    tabId: string | undefined,
    clear: boolean
  ): { entries: ConsoleEntry[] } {
    const entry = this.guestFor(sessionId, tabId)
    const entries = [...entry.console]
    if (clear) entry.console.length = 0
    return { entries }
  }

  /* ---------------- helpers ---------------- */

  /** wait until a load settles: resolves undefined on success, or the failure. */
  private awaitLoad(
    wc: WebContents,
    timeoutMs = LOAD_TIMEOUT_MS
  ): Promise<{ errorCode: number; errorDescription: string } | undefined> {
    return new Promise((resolve) => {
      let done = false
      const finish = (v: { errorCode: number; errorDescription: string } | undefined): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        wc.off('did-finish-load', onOk)
        wc.off('did-fail-load', onFail)
        resolve(v)
      }
      const onOk = (): void => finish(undefined)
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string,
        _url: string,
        isMainFrame: boolean
      ): void => {
        // sub-frame failures (ads, trackers) must not fail the top navigation
        if (isMainFrame) finish({ errorCode, errorDescription })
      }
      const timer = setTimeout(
        () => finish({ errorCode: -1, errorDescription: `load timed out after ${timeoutMs}ms` }),
        timeoutMs
      )
      wc.on('did-finish-load', onOk)
      wc.on('did-fail-load', onFail)
    })
  }

  /** poll the guest registry until this session has a live tab (goto ensure-tab). */
  private async waitForGuest(sessionId: string, timeoutMs: number): Promise<GuestEntry | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const map = this.guests.get(sessionId)
      if (map && map.size) {
        for (const e of map.values()) if (e.active) return e
        return map.values().next().value as GuestEntry
      }
      if (Date.now() >= deadline) return null
      await delay(100)
    }
  }

  private writeToken(): void {
    try {
      writeFileSync(this.tokenPath, this.token, { mode: 0o600 })
      chmodSync(this.tokenPath, 0o600)
    } catch (err) {
      console.error('[browserControl] failed to write token file:', err)
    }
  }

  /** (re)write <userData>/bin/hang4r — a shim that runs the CLI via Electron's
   *  bundled Node. Regenerated every boot because execPath/cliPath change across
   *  app updates and dev vs packaged. */
  private writeBinShim(): void {
    if (process.platform === 'win32') return // POSIX shim only; SSH/env still work
    try {
      rmSync(this.binDir, { recursive: true, force: true })
      mkdirSync(this.binDir, { recursive: true })
      const shim = join(this.binDir, 'hang4r')
      const script = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${this.cliPath}" "$@"\n`
      writeFileSync(shim, script, { mode: 0o755 })
      chmodSync(shim, 0o755)
    } catch (err) {
      console.error('[browserControl] failed to write bin shim:', err)
    }
  }
}

/* ---------------- arg coercion ---------------- */

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Missing "${name}".`)
  return v
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined
}
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface InjectResult {
  ok: boolean
  error: string
}

/* ---------------- injected page JS ----------------
 * Each snippet is an IIFE evaluated in the guest page via executeJavaScript.
 * Interactive-element refs (e1..eN) live on window.__h4rRefs and REGENERATE on
 * every snapshot — that contract is documented in the CLI --help. Value setters
 * go through the native prototype setter + input/change events so React/Vue
 * controlled inputs actually update (the cmux lesson). */

const REF_RESOLVER = `
  function __h4rResolve(target) {
    if (/^e[0-9]+$/.test(target)) {
      var refs = window.__h4rRefs || [];
      var el = refs[parseInt(target.slice(1), 10) - 1];
      if (!el || !el.isConnected) return { err: 'Ref ' + target + ' is stale or unknown — re-run snapshot.' };
      return { el: el };
    }
    var el2 = document.querySelector(target);
    if (!el2) return { err: 'No element matches selector: ' + target };
    return { el: el2 };
  }
  function __h4rSetValue(el, value) {
    var proto = el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : el instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
`

function snapshotJs(selector: string | undefined, compact: boolean): string {
  const sel = JSON.stringify(selector ?? 'body')
  return `(() => {
    var root = document.querySelector(${sel});
    if (!root) return '(no element matches ' + ${sel} + ')';
    var refs = [];
    window.__h4rRefs = refs;
    var CAP = ${OUTPUT_CAP};
    var COMPACT = ${compact ? 'true' : 'false'};
    var out = [];
    var len = 0;
    var truncated = false;
    function push(s) {
      if (truncated) return;
      if (len + s.length > CAP) { out.push('…truncated'); truncated = true; return; }
      out.push(s); len += s.length + 1;
    }
    var INTERACTIVE = { A:1, BUTTON:1, INPUT:1, SELECT:1, TEXTAREA:1 };
    var ROLES = { button:1, link:1, tab:1, checkbox:1, radio:1, menuitem:1, 'switch':1, option:1 };
    function role(el) {
      var r = el.getAttribute('role');
      return r && ROLES[r] ? r : null;
    }
    function interactive(el) {
      return !!INTERACTIVE[el.tagName] || !!role(el);
    }
    function visible(el) {
      var s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (el.hasAttribute('hidden')) return false;
      return true;
    }
    function clip(s, n) {
      s = (s || '').replace(/\\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '…' : s;
    }
    function label(el) {
      var aria = el.getAttribute('aria-label');
      if (aria) return clip(aria, 120);
      if (el.tagName === 'INPUT') {
        var t = el.getAttribute('type') || 'text';
        var ph = el.getAttribute('placeholder');
        var nm = el.getAttribute('name');
        return clip(t + (ph ? ' "' + ph + '"' : nm ? ' [' + nm + ']' : el.value ? ' =' + el.value : ''), 120);
      }
      if (el.tagName === 'TEXTAREA') return clip('textarea ' + (el.getAttribute('placeholder') || el.getAttribute('name') || ''), 120);
      if (el.tagName === 'SELECT') return clip('select =' + (el.value || ''), 120);
      return clip(el.innerText || el.value || el.getAttribute('title') || '', 120);
    }
    function directText(el) {
      var parts = [];
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3) { var t = n.textContent.replace(/\\s+/g, ' ').trim(); if (t) parts.push(t); }
      }
      return clip(parts.join(' '), 120);
    }
    function tagLabel(el) {
      var r = role(el);
      if (r) return r;
      var tag = el.tagName.toLowerCase();
      return tag === 'a' ? 'link' : tag;
    }
    function walk(el, depth) {
      if (truncated) return;
      if (el.nodeType !== 1) return;
      if (!visible(el)) return;
      var indent = new Array(depth + 1).join('  ');
      var isHeading = /^H[1-6]$/.test(el.tagName);
      var emitted = false;
      if (interactive(el)) {
        refs.push(el);
        push(indent + tagLabel(el) + ' "' + label(el) + '" [ref=e' + refs.length + ']');
        emitted = true;
      } else if (isHeading) {
        push(indent + el.tagName.toLowerCase() + ' "' + clip(el.innerText, 120) + '"');
        emitted = true;
      } else if (!COMPACT) {
        var dt = directText(el);
        if (dt) { push(indent + dt); emitted = true; }
      }
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], emitted ? depth + 1 : depth);
    }
    walk(root, 0);
    return out.join('\\n') || '(empty)';
  })()`
}

function clickJs(target: string): string {
  return `(() => {
    ${REF_RESOLVER}
    var r = __h4rResolve(${JSON.stringify(target)});
    if (r.err) return { ok: false, error: r.err };
    r.el.scrollIntoView({ block: 'center', inline: 'center' });
    r.el.click();
    return { ok: true };
  })()`
}

function typeJs(target: string, text: string): string {
  return `(() => {
    ${REF_RESOLVER}
    var r = __h4rResolve(${JSON.stringify(target)});
    if (r.err) return { ok: false, error: r.err };
    var el = r.el;
    if (typeof el.focus === 'function') el.focus();
    if (!('value' in el)) return { ok: false, error: 'Element is not a text field: ' + ${JSON.stringify(target)} };
    __h4rSetValue(el, ${JSON.stringify(text)});
    return { ok: true };
  })()`
}

function selectJs(target: string, value: string): string {
  return `(() => {
    ${REF_RESOLVER}
    var r = __h4rResolve(${JSON.stringify(target)});
    if (r.err) return { ok: false, error: r.err };
    var el = r.el;
    if (el.tagName !== 'SELECT') return { ok: false, error: 'Not a <select>: ' + ${JSON.stringify(target)} };
    var proto = window.HTMLSelectElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)});
    else el.value = ${JSON.stringify(value)};
    if (el.value !== ${JSON.stringify(value)}) return { ok: false, error: 'No option with value ' + ${JSON.stringify(value)} };
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`
}

function pressJs(key: string): string {
  const map: Record<string, string> = {
    Enter: 'Enter',
    Escape: 'Escape',
    Tab: 'Tab',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight'
  }
  const named = map[key]
  // named keys map key===code; single chars use their own key + a KeyX-ish code
  const keyVal = named ?? key
  const code =
    named ??
    (key.length === 1 && /[a-zA-Z]/.test(key)
      ? 'Key' + key.toUpperCase()
      : key.length === 1 && /[0-9]/.test(key)
        ? 'Digit' + key
        : key)
  return `(() => {
    var el = document.activeElement || document.body;
    var init = { key: ${JSON.stringify(keyVal)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return { ok: true };
  })()`
}

function scrollJs(dy: number, dx: number, selector: string | undefined): string {
  if (selector) {
    return `(() => {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'No element matches selector: ' + ${JSON.stringify(selector)} };
      el.scrollBy(${dx}, ${dy});
      return { ok: true };
    })()`
  }
  return `(() => { window.scrollBy(${dx}, ${dy}); return { ok: true }; })()`
}

function getTextJs(selector: string | undefined): string {
  const sel = JSON.stringify(selector ?? 'body')
  return `(() => {
    var el = document.querySelector(${sel});
    if (!el) return '(no element matches ' + ${sel} + ')';
    var t = el.innerText || '';
    return t.length > ${OUTPUT_CAP} ? t.slice(0, ${OUTPUT_CAP}) + '\\n…truncated' : t;
  })()`
}

function evalJs(js: string): string {
  return `(() => {
    function __h4rStringify(v) {
      if (v === undefined) return 'undefined';
      var seen = [];
      try {
        return JSON.stringify(v, function (k, val) {
          if (typeof val === 'object' && val !== null) {
            if (seen.indexOf(val) !== -1) return '[Circular]';
            seen.push(val);
          }
          if (typeof val === 'function') return '[Function]';
          return val;
        });
      } catch (e) { return String(v); }
    }
    try {
      var __r = eval(${JSON.stringify(js)});
      return { ok: true, json: __h4rStringify(__r) };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  })()`
}

function waitCheckJs(selector: string | undefined, text: string | undefined): string {
  return `(() => {
    ${selector ? `if (!document.querySelector(${JSON.stringify(selector)})) return false;` : ''}
    ${text ? `if ((document.body ? document.body.innerText : '').indexOf(${JSON.stringify(text)}) === -1) return false;` : ''}
    return true;
  })()`
}
