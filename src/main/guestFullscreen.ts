import { BrowserWindow, type WebContents } from 'electron'

/**
 * HTML fullscreen inside the embedded <webview>. Electron propagates the enter
 * (window native fullscreen + webview in the embedder's top layer) but not the
 * exit, so a stale embedder `fullscreenElement` can cover the whole app. Whatever
 * ends the guest's fullscreen tears down every layer and restores the window's
 * pre-guest state.
 */
interface State {
  /** the guest currently in HTML fullscreen, if any */
  guest: WebContents | null
  /** window fullscreen as the USER chose it (not caused by a guest) */
  userFs: boolean
  /** userFs at the moment the active guest entered */
  pre: boolean
  /** unwinds in flight — the window may still read fullscreen */
  settling: number
  /** a trigger arrived mid-unwind for a guest that is still registered */
  pending: boolean
}

const states = new WeakMap<BrowserWindow, State>()
const stateOf = (win: BrowserWindow): State => {
  let s = states.get(win)
  if (!s)
    states.set(
      win,
      (s = { guest: null, userFs: win.isFullScreen(), pre: false, settling: 0, pending: false })
    )
  return s
}

const EXIT_JS = 'void (document.fullscreenElement && document.exitFullscreen().catch(() => {}))'
const poke = (wc: WebContents): void => {
  if (!wc.isDestroyed()) wc.executeJavaScript(EXIT_JS, true).catch(() => {})
}

// bounded: an awaited exitFullscreen() on the embedder hung >60 s, and a
// timeout counts as "still fullscreen" so the caller keeps retrying
async function stillFullscreen(wc: WebContents): Promise<boolean> {
  if (wc.isDestroyed()) return false
  const probe = wc.executeJavaScript('!!document.fullscreenElement', true).catch(() => false)
  return Promise.race([probe, new Promise<boolean>((r) => setTimeout(() => r(true), 400))])
}

async function exitAndWait(wc: WebContents): Promise<void> {
  for (let i = 0; i < 12; i++) {
    if (!(await stillFullscreen(wc))) return
    poke(wc)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/**
 * Order matters: guest, then embedder, and only THEN the window. Electron
 * restores the window itself when the HTML-API fullscreen ends (and keeps a
 * window that was already fullscreen), and both exits only complete while the
 * window is still fullscreen — leaving first stranded the embedder's
 * fullscreenElement on the webview with the guest still fullscreen.
 */
async function unwind(win: BrowserWindow, windowAlreadyLeft = false): Promise<void> {
  const st = stateOf(win)
  const guest = st.guest
  if (!guest) return
  // one unwind per window: the exit pokes and the window fallback fire their
  // own leave events, which must coalesce instead of re-entering
  if (st.settling) {
    st.pending = true
    return
  }
  st.guest = null
  st.settling++
  try {
    // armed before any poke: Electron's own restore may land at any point
    let left = windowAlreadyLeft || st.pre || !win.isFullScreen()
    const onLeave = (): void => {
      left = true
    }
    win.once('leave-full-screen', onLeave)
    const deadline = Date.now() + 1500
    try {
      await exitAndWait(guest)
      if (win.isDestroyed()) return
      await exitAndWait(win.webContents)
      // Electron restores the window itself; calling setFullScreen(false) while
      // that macOS transition is in flight spun the main process. Last resort
      // only: nothing left within 1.5 s, still fullscreen, and not the user's.
      while (!left && Date.now() < deadline && !win.isDestroyed()) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (!left && !st.pre && !st.guest && !win.isDestroyed() && win.isFullScreen()) {
        win.setFullScreen(false)
      }
    } finally {
      if (!win.isDestroyed()) win.removeListener('leave-full-screen', onLeave)
    }
  } finally {
    st.settling--
    if (st.pending) {
      st.pending = false
      if (st.guest) void unwind(win)
    }
  }
}

/** the persisted/"chosen" fullscreen state — a guest-driven one is not the user's */
export function userFullScreen(win: BrowserWindow): boolean {
  const st = stateOf(win)
  return st.guest || st.settling ? st.pre : win.isFullScreen()
}

export function watchWindowFullscreen(win: BrowserWindow): void {
  const st = stateOf(win)
  win.on('enter-full-screen', () => {
    if (!st.guest) st.userFs = true
  })
  win.on('leave-full-screen', () => {
    st.userFs = false
    // green button / Esc / ⌃⌘F while a guest is fullscreen: the guest must follow
    if (st.guest) {
      st.pre = false
      void unwind(win, true)
    }
  })
}

export function watchGuestFullscreen(guest: WebContents): void {
  const winOf = (): BrowserWindow | null => {
    const host = guest.hostWebContents
    return host ? BrowserWindow.fromWebContents(host) : null
  }
  guest.on('enter-html-full-screen', () => {
    const win = winOf()
    if (!win) return
    const st = stateOf(win)
    if (!st.guest) st.pre = st.userFs
    st.guest = guest
  })
  guest.on('leave-html-full-screen', () => {
    const win = winOf()
    if (win && stateOf(win).guest === guest) void unwind(win)
  })
  // closing the tab / crashing mid-fullscreen never fires leave-html-full-screen
  guest.once('destroyed', () => {
    for (const win of BrowserWindow.getAllWindows())
      if (stateOf(win).guest === guest) void unwind(win)
  })
}
