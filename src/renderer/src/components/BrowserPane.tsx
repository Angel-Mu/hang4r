import { useEffect, useRef, useState, type JSX } from 'react'
import { useHang4r, type BrowserTab } from '../state/store'
import { FindBar } from './FindBar'

/** the subset of Electron's WebviewTag API we drive from the toolbar + report */
interface WebviewEl extends HTMLElement {
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  openDevTools(): void
  closeDevTools(): void
  isDevToolsOpened(): boolean
  findInPage(text: string, opts?: { forward?: boolean; findNext?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
}

let tabCounter = 0
function newTab(): BrowserTab {
  return { id: `bt-${Date.now().toString(36)}-${tabCounter++}`, url: '', current: null, tunneledPort: null }
}

function tabTitle(t: BrowserTab): string {
  if (!t.current) return 'New Tab'
  try {
    const u = new URL(t.url || t.current)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return t.url || 'Tab'
  }
}

/**
 * Embedded browser pane (Electron <webview>) with TABS, for previewing the dev
 * server or any site alongside the agent — Cursor's in-app browser. Tab state
 * lives in the store (splits/remounts keep it); every tab's webview stays
 * mounted so switching tabs never reloads the page. ⌘W closes the active TAB
 * (scoped close) — never the pane, never the window.
 */
export function BrowserPane({ sessionId }: { sessionId: string }): JSX.Element {
  const saved = useHang4r((s) => s.browserTabs[sessionId])
  const tabs = saved?.tabs ?? []
  const activeId = saved?.activeId ?? ''
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const webviewRefs = useRef(new Map<string, WebviewEl>())
  /** guest webContentsId per tab (available only after the webview attaches) */
  const wcIds = useRef(new Map<string, number>())
  const isSsh = useHang4r((s) => s.sessions.find((x) => x.id === sessionId)?.environment === 'ssh')
  const [invalid, setInvalid] = useState(false)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const [devtoolsHeight, setDevtoolsHeight] = useState(300)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [findMatches, setFindMatches] = useState<{ active: number; total: number } | null>(null)
  const [findFocusToken, setFindFocusToken] = useState(0)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)

  // first open: seed one empty tab
  useEffect(() => {
    if (!saved || saved.tabs.length === 0) {
      const t = newTab()
      useHang4r.getState().setBrowserTabs(sessionId, [t], t.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, saved === undefined])

  const commit = (nextTabs: BrowserTab[], nextActive: string): void =>
    useHang4r.getState().setBrowserTabs(sessionId, nextTabs, nextActive)

  const patchTab = (id: string, patch: Partial<BrowserTab>): void => {
    const cur = useHang4r.getState().browserTabs[sessionId]
    if (!cur) return
    commit(
      cur.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      cur.activeId
    )
  }

  const addTab = (): void => {
    const cur = useHang4r.getState().browserTabs[sessionId]
    const t = newTab()
    commit([...(cur?.tabs ?? []), t], t.id)
    setInvalid(false)
  }

  const closeTab = (id: string): void => {
    const cur = useHang4r.getState().browserTabs[sessionId]
    if (!cur) return
    webviewRefs.current.delete(id)
    const rest = cur.tabs.filter((t) => t.id !== id)
    if (rest.length === 0) {
      // last tab closed → back to a single empty tab (the pane stays open)
      const t = newTab()
      commit([t], t.id)
      return
    }
    const idx = cur.tabs.findIndex((t) => t.id === id)
    const nextActive =
      cur.activeId === id ? rest[Math.max(0, idx - 1)].id : cur.activeId
    commit(rest, nextActive)
  }

  const go = (target?: string, tabIdArg?: string): void => {
    const cur = useHang4r.getState().browserTabs[sessionId]
    const tab =
      (tabIdArg ? cur?.tabs.find((t) => t.id === tabIdArg) : undefined) ??
      cur?.tabs.find((t) => t.id === cur?.activeId) ??
      cur?.tabs[0]
    if (!tab) return
    let dest = (target ?? tab.url).trim()
    if (!dest) return
    // "not a url" with spaces would load verbatim into a blank page — treat a
    // space-containing non-URL as invalid instead of guessing a search
    if (!/^https?:\/\//.test(dest)) {
      if (/\s/.test(dest)) {
        setInvalid(true)
        return
      }
      dest = 'http://' + dest
    }
    let parsed: URL
    try {
      parsed = new URL(dest)
    } catch {
      setInvalid(true)
      return
    }
    setInvalid(false)
    // ssh session + localhost target → the server lives on the REMOTE host:
    // transparently open an ssh -L tunnel and browse its local end instead
    if (isSsh && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      const remotePort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      const tabId = tab.id
      patchTab(tabId, { url: dest })
      void window.hang4r
        .openRemoteTunnel(sessionId, remotePort)
        .then(({ localPort }) => {
          parsed.port = String(localPort)
          patchTab(tabId, { tunneledPort: remotePort, current: parsed.toString() })
        })
        .catch(() => {
          patchTab(tabId, { tunneledPort: null })
          setInvalid(true)
        })
      return
    }
    patchTab(tab.id, { tunneledPort: null, current: dest, url: dest })
  }

  /** a clicked link must never clobber a tab with content — reuse only a pristine tab */
  const openFromLink = (url: string): void => {
    const cur = useHang4r.getState().browserTabs[sessionId]
    const activeTab = cur?.tabs.find((t) => t.id === cur.activeId) ?? cur?.tabs[0]
    if (activeTab && !activeTab.current && !activeTab.url.trim()) {
      go(url, activeTab.id)
      return
    }
    const t = newTab()
    commit([...(cur?.tabs ?? []), t], t.id)
    go(url, t.id)
  }

  const focusAddress = (): void => {
    urlInputRef.current?.focus()
    urlInputRef.current?.select()
  }

  const cycleTab = (dir: number): void => {
    const cur = useHang4r.getState().browserTabs[sessionId]
    if (!cur || cur.tabs.length < 2) return
    const idx = cur.tabs.findIndex((t) => t.id === cur.activeId)
    const next = cur.tabs[(idx + dir + cur.tabs.length) % cur.tabs.length]
    commit(cur.tabs, next.id)
    setInvalid(false)
  }

  /**
   * DevTools DOCKED in the tab. The devtools frontend renders into a native
   * WebContentsView (main-process) that we position over the reserved slot at
   * the bottom of the pane. A <webview> guest can't host devtools (Chromium
   * disallows it — that's why the old in-pane attempt was empty), but a
   * WebContentsView can. Toggling just flips state; the effect below docks the
   * active tab's guest and keeps the native view's bounds glued to the slot.
   */
  const toggleDevTools = (): void => {
    setDevtoolsOpen((o) => !o)
  }

  /** push the active tab's guest devtools into the native view over the slot */
  const dockDevtoolsNow = (): boolean => {
    const el = slotRef.current
    const guestWcId = active ? wcIds.current.get(active.id) : undefined
    if (!el || guestWcId === undefined || !active?.current) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    void window.hang4r.dockDevtools(guestWcId, { x: r.left, y: r.top, width: r.width, height: r.height })
    return true
  }
  const syncDevtoolsBounds = (): void => {
    const el = slotRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return
    void window.hang4r.setDevtoolsBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
  }

  /* ---- find in page (⌘F) — Electron's webview.findInPage ---- */
  const runFind = (text: string, opts?: { forward?: boolean; findNext?: boolean }): void => {
    const wv = active ? webviewRefs.current.get(active.id) : undefined
    if (!wv) return
    if (!text) {
      wv.stopFindInPage('clearSelection')
      setFindMatches(null)
      return
    }
    wv.findInPage(text, opts)
  }
  const openFind = (): void => {
    setFindOpen(true)
    // bump the token so the shared FindBar (re)focuses + selects, matching a
    // repeat ⌘F on the chat/editor bars
    setFindFocusToken((t) => t + 1)
    if (findText) runFind(findText)
  }
  const closeFind = (): void => {
    active && webviewRefs.current.get(active.id)?.stopFindInPage('clearSelection')
    setFindOpen(false)
    setFindMatches(null)
  }

  /**
   * Standard browser keys when focus is anywhere in the HOST renderer (blank
   * tab, the chrome, or just-switched-to-Browser with no explicit focus). This
   * is attached at the WINDOW level (see the effect below), NOT as the pane's
   * onKeyDown — a div's onKeyDown only fires when that div has DOM focus, which
   * it usually doesn't right after you open the Browser tab. THAT is why the
   * keys "only worked once a page was loaded and clicked" (then the guest has
   * focus and main's before-input-event handles them). Now both paths exist:
   * guest focus → main before-input-event; host focus → this window handler.
   */
  const handleBrowserKey = (e: KeyboardEvent): void => {
    const el = document.activeElement as HTMLElement | null
    const inOwnInput = el === urlInputRef.current || el === findInputRef.current
    // never hijack a key typed into some OTHER text field (e.g. the chat
    // composer shown beside the browser); the address/find bars are ours
    const inForeignInput =
      !inOwnInput &&
      !!el &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    // F12 (no modifier) toggles devtools — handle before the meta-key guard
    if (e.key === 'F12' && !inForeignInput) {
      e.preventDefault()
      e.stopImmediatePropagation()
      toggleDevTools()
      return
    }
    if (!e.metaKey || e.ctrlKey || inForeignInput) return
    const key = e.key.toLowerCase()
    const claim = (): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const wv = active ? webviewRefs.current.get(active.id) : undefined
    // DevTools: ⌘I/⌘J and ⌥⌘I/⌥⌘J. Match on e.CODE, not e.key — Option mangles
    // e.key into a dead char (⌥I → 'ˆ'), which is why ⌥⌘I/⌥⌘J did nothing.
    if (e.code === 'KeyI' || e.code === 'KeyJ') {
      claim()
      toggleDevTools()
      return
    }
    if (e.altKey) {
      if (key === 'arrowleft') {
        claim()
        cycleTab(-1)
      } else if (key === 'arrowright') {
        claim()
        cycleTab(1)
      }
      return
    }
    // NOTE: ⌘F is intentionally NOT handled here. It belongs to whatever panel
    // has focus (conversation / file / terminal / browser), routed by App.tsx —
    // claiming it globally here hijacked the chat/file search (Angel). When the
    // browser CHROME has focus App.tsx opens our find; when the guest PAGE has
    // focus main's before-input-event emits the 'find' hotkey.
    if (key === 'l') {
      claim()
      focusAddress()
    } else if (key === 'r') {
      claim()
      if (e.shiftKey) wv?.reloadIgnoringCache()
      else wv?.reload()
    } else if (key === 't' && !e.shiftKey) {
      claim()
      addTab()
    } else if ((key === '[' || key === 'arrowleft') && !inOwnInput) {
      claim()
      wv?.goBack()
    } else if ((key === ']' || key === 'arrowright') && !inOwnInput) {
      claim()
      wv?.goForward()
    }
  }
  // keep a live ref so the window listener always calls the latest closure
  // (active tab, devtools state) without re-subscribing on every render
  const browserKeyRef = useRef(handleBrowserKey)
  browserKeyRef.current = handleBrowserKey

  // keep the URL bar honest: back/forward/reload and in-page navigation must
  // reflect in the bar (webview did-navigate events), per tab
  useEffect(() => {
    const offs: (() => void)[] = []
    for (const t of tabs) {
      if (!t.current) continue
      const wv = webviewRefs.current.get(t.id) as
        | (WebviewEl & { addEventListener: HTMLElement['addEventListener'] })
        | null
      if (!wv) continue
      const onNav = (e: Event): void => {
        const navUrl = (e as Event & { url?: string }).url
        // while tunneling, the webview browses the LOCAL tunnel end — keep the
        // bar showing the remote address the user typed
        if (navUrl && t.tunneledPort === null) patchTab(t.id, { url: navUrl })
      }
      const onFound = (e: Event): void => {
        // only the active tab is ever searched, so any result is the current one
        const r = (e as Event & { result?: { activeMatchOrdinal: number; matches: number } }).result
        if (r) setFindMatches({ active: r.activeMatchOrdinal, total: r.matches })
      }
      wv.addEventListener('did-navigate', onNav)
      wv.addEventListener('did-navigate-in-page', onNav)
      wv.addEventListener('found-in-page', onFound)
      offs.push(() => {
        wv.removeEventListener('did-navigate', onNav)
        wv.removeEventListener('did-navigate-in-page', onNav)
        wv.removeEventListener('found-in-page', onFound)
      })
    }
    return () => offs.forEach((f) => f())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.map((t) => `${t.id}:${t.current}:${t.tunneledPort}`).join('|')])

  // Report this session's live browser tabs to the main-process control plane so
  // the `hang4r browser` CLI can resolve and drive them. Re-report on any change
  // (attach, navigate, title, active-tab switch); an empty report on unmount
  // (below) tells main the pane's webviews are gone.
  useEffect(() => {
    const sendReport = (): void => {
      const cur = useHang4r.getState().browserTabs[sessionId]
      const list = cur?.tabs ?? []
      const activeTabId = cur?.activeId ?? ''
      const payload: {
        tabId: string
        webContentsId: number
        url: string
        title: string
        active: boolean
      }[] = []
      for (const t of list) {
        if (!t.current) continue
        const wcId = wcIds.current.get(t.id)
        const wv = webviewRefs.current.get(t.id)
        if (wcId === undefined || !wv) continue
        let url = t.url || t.current
        let title = ''
        try {
          url = wv.getURL() || url
        } catch {
          /* not attached yet */
        }
        try {
          title = wv.getTitle() || ''
        } catch {
          /* not attached yet */
        }
        payload.push({ tabId: t.id, webContentsId: wcId, url, title, active: t.id === activeTabId })
      }
      void window.hang4r.reportBrowserGuests({ sessionId, tabs: payload })
    }
    const offs: (() => void)[] = []
    for (const t of tabs) {
      if (!t.current) continue
      const wv = webviewRefs.current.get(t.id) as
        | (WebviewEl & { addEventListener: HTMLElement['addEventListener'] })
        | null
      if (!wv) continue
      // Capture the guest's webContentsId. did-attach can fire BEFORE this effect
      // runs (so we could miss the event), so also try to read it eagerly and
      // retry a few times — otherwise a fast data:/instant page never reports.
      const tryCapture = (): void => {
        if (wcIds.current.has(t.id)) return
        try {
          wcIds.current.set(t.id, wv.getWebContentsId())
          sendReport()
        } catch {
          /* not attached yet — a retry or did-attach will catch it */
        }
      }
      const onAttach = (): void => {
        try {
          wcIds.current.set(t.id, wv.getWebContentsId())
        } catch {
          /* not attached yet */
        }
        sendReport()
      }
      const onChange = (): void => sendReport()
      wv.addEventListener('did-attach', onAttach)
      wv.addEventListener('dom-ready', onAttach)
      wv.addEventListener('did-navigate', onChange)
      wv.addEventListener('did-navigate-in-page', onChange)
      wv.addEventListener('page-title-updated', onChange)
      tryCapture()
      const timers = [30, 120, 400, 1000, 2500].map((ms) => setTimeout(tryCapture, ms))
      offs.push(() => {
        timers.forEach(clearTimeout)
        wv.removeEventListener('did-attach', onAttach)
        wv.removeEventListener('dom-ready', onAttach)
        wv.removeEventListener('did-navigate', onChange)
        wv.removeEventListener('did-navigate-in-page', onChange)
        wv.removeEventListener('page-title-updated', onChange)
      })
    }
    // report now too — covers a plain active-tab switch (webviews already attached)
    sendReport()
    return () => offs.forEach((f) => f())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tabs.map((t) => `${t.id}:${t.current}:${t.id === active?.id}`).join('|')])

  // pane unmount (context switched away / tile closed): the webviews are
  // destroyed, so clear this session's guests — an agent's goto must then
  // re-open a Browser tab (honest "no browser tab open" until it does)
  useEffect(() => {
    return () => {
      void window.hang4r.reportBrowserGuests({ sessionId, tabs: [] })
    }
  }, [sessionId])

  // clicked link somewhere in this session (terminal, chat) → open it in a NEW
  // tab (reusing only a pristine one) — Angel lost work to a link replacing the
  // tab he was using
  const urlToOpen = useHang4r((s) => s.urlToOpen)
  useEffect(() => {
    if (urlToOpen && urlToOpen.sessionId === sessionId) {
      openFromLink(urlToOpen.url)
      // one-shot: clear it so a later pane REMOUNT (switching panels away and
      // back) doesn't replay the same url into another duplicate tab
      useHang4r.getState().consumeUrlToOpen(urlToOpen.nonce)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlToOpen?.nonce])

  // browser keybinding intercepted by main while the guest page had focus
  const hotkey = useHang4r((s) => s.browserHotkey)
  useEffect(() => {
    if (!hotkey || hotkey.sessionId !== sessionId) return
    if (hotkey.action === 'focus-address') focusAddress()
    else if (hotkey.action === 'new-tab') addTab()
    else if (hotkey.action === 'close-tab') closeTab(hotkey.tabId)
    else if (hotkey.action === 'prev-tab') cycleTab(-1)
    else if (hotkey.action === 'next-tab') cycleTab(1)
    else if (hotkey.action === 'toggle-devtools') toggleDevTools()
    else if (hotkey.action === 'find') openFind()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotkey?.nonce])

  // dock the native devtools view over the slot while open, and keep its bounds
  // glued to the slot as the layout changes (resize, splits, sidebar toggle).
  // Re-runs on tab switch to re-target the new guest.
  useEffect(() => {
    if (!devtoolsOpen) {
      void window.hang4r.closeDevtools()
      return
    }
    let raf = 0
    const tryDock = (): void => {
      // the guest's webContents id / slot may not be ready for a frame or two
      if (!dockDevtoolsNow()) raf = requestAnimationFrame(tryDock)
    }
    tryDock()
    const ro = new ResizeObserver(() => syncDevtoolsBounds())
    if (slotRef.current) ro.observe(slotRef.current)
    if (paneRef.current) ro.observe(paneRef.current)
    const onWin = (): void => syncDevtoolsBounds()
    window.addEventListener('resize', onWin)
    // a light poll catches POSITION shifts that don't resize the slot (a sidebar
    // toggle or tile move slides the pane without changing the slot's size)
    const iv = window.setInterval(syncDevtoolsBounds, 300)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', onWin)
      clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devtoolsOpen, active?.id, active?.current])

  // switching this tile away from Browser unmounts the pane — tear down the
  // native devtools view so it doesn't hang over another panel
  useEffect(() => {
    return () => {
      void window.hang4r.closeDevtools()
    }
  }, [])

  // ⌘W closes the active browser TAB — the pane/tile only via its own ×
  const isFocused = useHang4r((s) => s.focusedSessionId === sessionId)

  // a blank tab has no webview to catch ⌘L, and focus usually isn't in the pane
  // yet — drop the cursor in the address bar so a fresh tab is immediately
  // typeable (Angel: ⌘L did nothing on a new blank tab)
  useEffect(() => {
    if (isFocused && active && !active.current) urlInputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, active?.id, active?.current])

  // window-level browser keybindings for THIS pane while its session is focused
  // (only the active-context Browser pane is mounted, so this is the visible
  // one). Capture phase so ⌘L/⌘T etc. land before App.tsx — ⌘F is deliberately
  // NOT claimed here; App.tsx routes it to the focused panel.
  useEffect(() => {
    if (!isFocused) return
    const h = (e: KeyboardEvent): void => browserKeyRef.current(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [isFocused])

  // ⌘F while the browser CHROME has focus → App.tsx dispatches this to our pane
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const onFind = (): void => openFind()
    el.addEventListener('hang4r-find-toggle', onFind)
    return () => el.removeEventListener('hang4r-find-toggle', onFind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!isFocused) return
    useHang4r.getState().setScopedClose(() => {
      const cur = useHang4r.getState().browserTabs[sessionId]
      if (!cur || !cur.tabs.length) return false
      const act = cur.tabs.find((t) => t.id === cur.activeId)
      // an empty lone tab has nothing to close — let ⌘W fall through
      if (cur.tabs.length === 1 && !act?.current) return false
      closeTab(cur.activeId)
      return true
    })
    return () => useHang4r.getState().setScopedClose(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, sessionId])

  return (
    <div className="browser-pane" data-session={sessionId} ref={paneRef}>
      <div className="browser-tabs">
        {tabs.map((t) => (
          <span
            key={t.id}
            className={'browser-tab' + (t.id === active?.id ? ' browser-tab-active' : '')}
            title={t.url || 'New Tab'}
            onClick={() => {
              commit(tabs, t.id)
              setInvalid(false)
            }}
          >
            <span className="browser-tab-title">{tabTitle(t)}</span>
            <button
              className="browser-tab-close"
              title="Close tab (⌘W)"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ×
            </button>
          </span>
        ))}
        <button className="browser-tab-add" title="New tab" onClick={addTab}>
          +
        </button>
      </div>
      <div className="browser-toolbar">
        <button
          className="ghost-btn"
          title="Back"
          onClick={() => active && webviewRefs.current.get(active.id)?.goBack()}
        >
          ←
        </button>
        <button
          className="ghost-btn"
          title="Forward"
          onClick={() => active && webviewRefs.current.get(active.id)?.goForward()}
        >
          →
        </button>
        <button
          className="ghost-btn"
          title="Reload"
          onClick={() => active && webviewRefs.current.get(active.id)?.reload()}
        >
          ↻
        </button>
        <input
          ref={urlInputRef}
          className={'browser-url field' + (invalid ? ' browser-url-invalid' : '')}
          placeholder="localhost:3000 or any URL — ⏎ to open"
          title={invalid ? 'Not a loadable URL' : undefined}
          value={active?.url ?? ''}
          onChange={(e) => {
            if (active) patchTab(active.id, { url: e.target.value })
            setInvalid(false)
          }}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        {active && active.tunneledPort !== null && (
          <span
            className="browser-tunnel-chip"
            title={`Forwarded from the remote host: localhost:${active.tunneledPort} over ssh -L`}
          >
            via tunnel :{active.tunneledPort}
          </span>
        )}
        <button className="ghost-btn" onClick={() => go('http://localhost:3000')}>
          :3000
        </button>
        <button className="ghost-btn" onClick={() => go('http://localhost:5173')}>
          :5173
        </button>
        <button
          className={'ghost-btn' + (devtoolsOpen ? ' ghost-btn-active' : '')}
          title="Toggle DevTools (⌘I · opens this tab's inspector)"
          onClick={toggleDevTools}
        >
          {'</>'}
        </button>
      </div>
      {findOpen && (
        <FindBar
          placeholder="Find in page"
          query={findText}
          onQueryChange={(q) => {
            setFindText(q)
            runFind(q)
          }}
          count={findMatches?.total ?? 0}
          active={findMatches ? Math.max(findMatches.active - 1, 0) : 0}
          onNext={() => runFind(findText, { forward: true, findNext: true })}
          onPrev={() => runFind(findText, { forward: false, findNext: true })}
          onClose={closeFind}
          focusToken={findFocusToken}
          inputRef={findInputRef}
        />
      )}
      <div className="browser-content">
        <div className="browser-stage">
          {tabs.map((t) =>
            t.current ? (
              // every tab's webview stays mounted (hidden when inactive) so
              // switching tabs never reloads the page
              <webview
                key={t.id}
                ref={((el: WebviewEl | null) => {
                  if (el) webviewRefs.current.set(t.id, el)
                  else webviewRefs.current.delete(t.id)
                }) as never}
                className="browser-webview"
                style={t.id === active?.id ? undefined : { display: 'none' }}
                src={t.current}
                // isolate embedded pages from the app
                partition="persist:hang4r-browser"
              />
            ) : null
          )}
          {!active?.current && (
            <div className="diff-empty">
              Enter a URL — usually your dev server — and preview it next to the agent.
            </div>
          )}
        </div>
        {devtoolsOpen && active?.current && (
          <>
            <div
              className="browser-devtools-resizer"
              onMouseDown={(e) => {
                e.preventDefault()
                const startY = e.clientY
                const startH = devtoolsHeight
                const onMove = (m: MouseEvent): void =>
                  setDevtoolsHeight(Math.min(Math.max(startH + (startY - m.clientY), 120), 900))
                const onUp = (): void => {
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
            />
            {/* the native devtools WebContentsView is positioned over this slot */}
            <div ref={slotRef} className="browser-devtools-slot" style={{ height: devtoolsHeight }} />
          </>
        )}
      </div>
    </div>
  )
}
