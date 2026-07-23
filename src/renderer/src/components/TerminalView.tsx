import { useEffect, useRef, useState, type JSX } from 'react'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useHang4r } from '../state/store'
import { cssToken } from '../theme'
import { TerminalFindBar } from './TerminalFindBar'
import {
  loadTerminalKeymap,
  matchesChord,
  resolveActionBytes,
  NATURAL_KEYMAP_DEFAULTS,
  type KeyBinding
} from '../terminalKeymap'

// URLs and file-ish paths (optional dirs, extension with a letter so version
// numbers like 3.14 don't linkify, optional :line[:col]). Top-level files
// (README.md, package.json, ./tsconfig.json) must match too.
const URL_RE = /https?:\/\/[^\s"'<>()[\]{}]+[^\s"'<>()[\]{}.,;:!?]/g
const PATH_RE =
  /(?:\.{1,2}\/|\/)?[\w@~+-][\w.@~+-]*(?:\/[\w.@~+-]+)*\.\w*[a-zA-Z]\w{0,7}(?::\d+(?::\d+)?)?/g

/** register ⌘/alt-click link handling for URLs (→ inner browser) and file
 *  paths (→ editor) on a terminal's visible buffer */
function registerLinks(term: Terminal, sessionId: string): void {
  term.registerLinkProvider({
    provideLinks(lineNo, cb) {
      const line = term.buffer.active.getLine(lineNo - 1)?.translateToString(true) ?? ''
      const links: ILink[] = []
      const push = (index: number, text: string, activate: () => void): void => {
        links.push({
          range: { start: { x: index + 1, y: lineNo }, end: { x: index + text.length, y: lineNo } },
          text,
          activate: (ev: MouseEvent) => {
            // plain click stays in the terminal (selection etc); ⌘/alt opens
            if (ev.metaKey || ev.altKey) activate()
          }
        })
      }
      for (const m of line.matchAll(URL_RE)) {
        push(m.index ?? 0, m[0], () => useHang4r.getState().requestOpenUrl(sessionId, m[0]))
      }
      for (const m of line.matchAll(PATH_RE)) {
        const text = m[0]
        // skip anything inside an already-matched URL
        if ([...line.matchAll(URL_RE)].some((u) => (u.index ?? 0) <= (m.index ?? 0) && (u.index ?? 0) + u[0].length >= (m.index ?? 0) + text.length)) continue
        const lm = /:(\d+)(?::\d+)?$/.exec(text)
        const path = lm ? text.slice(0, lm.index) : text
        const lineNum = lm ? Number(lm[1]) : undefined
        push(m.index ?? 0, text, () =>
          useHang4r.getState().requestOpenFile(sessionId, path.replace(/^\.\//, ''), lineNum)
        )
      }
      cb(links.length ? links : undefined)
    }
  })
}

/**
 * A real shell for a terminal id, running in the session's worktree/repo cwd.
 * The PTY is hosted in the main process (PtyService) and streamed here via IPC.
 * `id` lets a session own multiple terminals; each id is a distinct PTY.
 */
export function TerminalView({
  sessionId,
  id,
  command,
  active
}: {
  sessionId: string
  id: string
  /** when set, run this command as a dev/service process instead of a shell */
  command?: string
  /** this pane is the active one — focus its xterm when it becomes active
   *  (⌘[ / ⌘] pane nav, list click) so typing lands here without a mouse click */
  active?: boolean
}): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  // ⌘F unified find bar scoped to THIS terminal (round 13 ①). App.tsx dispatches
  // 'hang4r-find-toggle' on the focused terminal's wrapper; the search addon is
  // published to state once the terminal mounts so the bar can drive it.
  const [search, setSearch] = useState<SearchAddon | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findToken, setFindToken] = useState(0)
  const termRef = useRef<Terminal | null>(null)
  // focus the xterm on a false→true active transition only (not on mount, which
  // would steal focus when the panel first opens) — makes ⌘[ / ⌘] pane nav and
  // terminal-list clicks land the cursor in the pane without a mouse click
  const wasActiveRef = useRef(!!active)
  useEffect(() => {
    if (active && !wasActiveRef.current) termRef.current?.focus()
    wasActiveRef.current = !!active
  }, [active])

  useEffect(() => {
    const wrapper = wrapperRef.current
    const container = hostRef.current
    if (!wrapper || !container) return

    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      // No dedicated terminal-font setting exists, so track the app-wide "Chat
      // font size" (Settings → General) — read once at mount, so it applies to
      // NEW terminals; existing ones keep the size they opened with.
      // the terminal is a code/CLI surface — size it with the EDITOR font, not
      // the chat font (which users bump for chat readability, making the terminal
      // look oversized — Angel)
      fontSize: useHang4r.getState().editorFontSize || 12,
      // follow the ACTIVE app theme's tokens (read at mount) instead of a
      // baked-in palette — under nord/light the old hexes matched nothing,
      // and the near-white-on-black default was an eye-strain hotspot
      theme: {
        background: cssToken('--bg', '#0e0f13'),
        foreground: cssToken('--text', '#ced2dc'),
        cursor: cssToken('--accent', '#a48fe0')
      },
      cursorBlink: true,
      // @xterm/addon-search paints match highlights via the decorations API,
      // which xterm gates behind "proposed API" — required for ⌘F find (round 13 ①)
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    term.open(container)
    registerLinks(term, sessionId)
    termRef.current = term
    setSearch(searchAddon)

    let disposed = false
    const offData = window.hang4r.onTerminalData((tid, data) => {
      if (tid === id) term.write(data)
    })
    const inputDisp = term.onData((data) => window.hang4r.writeTerminal(id, data))

    // Fit only once the container actually has a size, then spawn the PTY.
    // (Mounting inside a freshly-opened resizable panel can start at 0×0.)
    const startWhenSized = (): void => {
      if (disposed) return
      if (container.clientWidth < 20 || container.clientHeight < 20) {
        requestAnimationFrame(startWhenSized)
        return
      }
      try {
        fit.fit()
      } catch {
        /* not laid out yet */
      }
      if (command) void window.hang4r.startProcess(id, sessionId, command, term.cols || 120, term.rows || 30)
      else void window.hang4r.startTerminal(id, sessionId, term.cols || 80, term.rows || 24)
    }
    requestAnimationFrame(startWhenSized)

    const ro = new ResizeObserver(() => {
      if (disposed || container.clientWidth < 20) return
      try {
        fit.fit()
        window.hang4r.resizeTerminal(id, term.cols, term.rows)
      } catch {
        /* container detached mid-resize */
      }
    })
    ro.observe(container)

    // ⌘K clear (iTerm2-style) and ⌘F find — both dispatched by the app-level
    // key handler onto this terminal's WRAPPER (`.terminal-view`, what its
    // focused textarea resolves to via .closest).
    const onClear = (): void => {
      term.clear()
      void window.hang4r.clearTerminal(id) // drop the replay buffer too — stays clear across tab switches
    }
    wrapper.addEventListener('hang4r-clear', onClear)
    const onFind = (): void => {
      setFindOpen(true)
      setFindToken((t) => t + 1)
    }
    wrapper.addEventListener('hang4r-find-toggle', onFind)

    // Configurable terminal key bindings (iTerm2 "Key Mappings" style), loaded
    // once per mount — edits in Settings apply to new terminals. Defaults to
    // the natural-text-editing preset until the setting resolves.
    let keymap: KeyBinding[] = NATURAL_KEYMAP_DEFAULTS
    void loadTerminalKeymap().then((km) => {
      keymap = km
    })
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // ⌘C copies the selection. The terminal renders to a canvas — its selection
      // is xterm's own, NOT a DOM selection — so the OS copy never sees it and
      // ⌘C did nothing (Angel: "cannot copy text from the terminal"). Wire it
      // explicitly. With NO selection, fall through so ⌘C is a no-op here and
      // never sends SIGINT — that's ⌃C's job. (Paste already works: ⌘V feeds
      // xterm's hidden input textarea natively.)
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection()
        if (sel) {
          void navigator.clipboard.writeText(sel).catch(() => {})
          e.preventDefault()
          return false
        }
        return true
      }
      for (const b of keymap) {
        if (!matchesChord(e, b.key)) continue
        // returning false stops xterm's keydown handling, but a PRINTABLE bound
        // key would still reach the shell via the hidden textarea's input event
        // — preventDefault suppresses that, so only the action's bytes go out
        e.preventDefault()
        if (b.action === 'clear-screen') {
          term.clear()
          void window.hang4r.clearTerminal(id) // drop the replay buffer too
          return false
        }
        const bytes = resolveActionBytes(b)
        if (bytes) void window.hang4r.writeTerminal(id, bytes)
        return false
      }
      return true
    })

    return () => {
      disposed = true
      offData()
      inputDisp.dispose()
      ro.disconnect()
      wrapper.removeEventListener('hang4r-clear', onClear)
      wrapper.removeEventListener('hang4r-find-toggle', onFind)
      termRef.current = null
      setSearch(null)
      term.dispose()
      // PTY persists in main across tab switches; disposed when the terminal closes.
    }
  }, [sessionId, id])

  return (
    <div className="terminal-view" ref={wrapperRef}>
      <div className="terminal-xterm-host" ref={hostRef} />
      {findOpen && search && (
        <TerminalFindBar
          search={search}
          focusToken={findToken}
          onClose={() => {
            setFindOpen(false)
            search.clearDecorations()
            termRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
