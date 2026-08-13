import { useEffect, useState, type JSX } from 'react'
import type { UpdateStatus } from '../../shared/protocol'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { NewSessionDialog } from './components/NewSessionDialog'
import { UsageBar } from './components/UsageBar'
import { WorkingPanel } from './components/WorkingPanel'
import { CommandPalette } from './components/CommandPalette'
import { FileFinder } from './components/FileFinder'
import { Settings } from './components/Settings'
import { ContextMenu } from './components/ContextMenu'
import { Lightbox } from './components/Lightbox'
import { InputDialog } from './components/InputDialog'
import { ArchivedSessions } from './components/ArchivedSessions'
import { CursorImport } from './components/CursorImport'
import { QuitConfirm } from './components/QuitConfirm'
import { SidebarRail } from './components/SidebarRail'
import { Icon } from './components/Icon'
import { useHang4r } from './state/store'
import { applyTheme } from './theme'
import { focusPane } from './focusScope'

/** Titlebar update pill — surfaces the update state (auto-check or a manual
 *  "Check for Updates"). Downloads happen in the background; this offers a
 *  one-click restart, and now shows the RESULT of a manual check so that command
 *  no longer has to open Settings (Angel). The transient informational results
 *  (up-to-date / error) auto-hide after a beat. Never auto-closes the app. */
function UpdatePill(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    void window.hang4r.getUpdateStatus().then(setStatus)
    return window.hang4r.onUpdateStatus((s) => {
      setDismissed(false) // a fresh status re-shows the pill
      setStatus(s)
    })
  }, [])
  // "you're up to date" / "check failed" are terminal info — show, then fade out
  useEffect(() => {
    if (status.state !== 'not-available' && status.state !== 'error') return
    const t = setTimeout(() => setDismissed(true), status.state === 'error' ? 6000 : 4000)
    return () => clearTimeout(t)
  }, [status])
  if (status.state === 'checking') {
    return (
      <button className="update-pill" disabled title="Checking for updates…">
        Checking for updates…
      </button>
    )
  }
  if (!dismissed && status.state === 'not-available') {
    return (
      <button
        className="update-pill"
        title={`You're on the latest version${status.version ? ` · ${status.version}` : ''}`}
        onClick={() => setDismissed(true)}
      >
        You&apos;re up to date
      </button>
    )
  }
  if (!dismissed && status.state === 'error') {
    return (
      <button
        className="update-pill"
        title={status.message}
        onClick={() => void window.hang4r.checkForUpdates()}
      >
        Update check failed — retry
      </button>
    )
  }
  if (status.state === 'downloaded') {
    return (
      <button
        className="update-pill update-pill-ready"
        title={`Version ${status.version} downloaded — restart to finish (or it installs next time you quit)`}
        onClick={() => void window.hang4r.installUpdate()}
      >
        ↻ Restart to update{status.version ? ` · ${status.version}` : ''}
      </button>
    )
  }
  if (status.state === 'available' || status.state === 'downloading') {
    const label =
      status.state === 'downloading'
        ? `Downloading update… ${status.percent ?? 0}%`
        : `Update ${status.version ?? ''} available`
    return (
      <button
        className="update-pill"
        title="A new version is downloading in the background — you'll get a Restart button when it's ready"
        onClick={() => useHang4r.getState().setSettingsOpen(true)}
      >
        ⬇ {label}
      </button>
    )
  }
  return null
}

/**
 * ⌘W / File → Close. Each context pane registers a "close top scope" fn KEYED by
 * pane (editor file / terminal tab / browser tab). Route by where DOM focus
 * actually is (focusPane), then dispatch to THAT pane's fn — never a single
 * shared slot, whose last-writer-wins let a background browser tab hijack the
 * editor's ⌘W, and never by focused-TILE, which fired while you typed in the
 * conversation and blanked a panel. No pane focused → close the whole tile.
 */
function closeFocusedScope(): void {
  const s = useHang4r.getState()
  // Route by where DOM focus actually is (focusPane), NOT which tile is focused,
  // and dispatch to THAT pane's own close fn — so ⌘W in the editor always closes
  // the editor file, never a background browser tab that happened to register last.
  const pane = focusPane()
  const fn = pane !== 'other' ? s.scopedClose[pane] : undefined
  const closed = fn ? fn() : false
  if (!closed && s.focusedSessionId) s.closeTile(s.focusedSessionId)
}

export default function App(): JSX.Element {
  const init = useHang4r((s) => s.init)
  const sidebarVisible = useHang4r((s) => s.sidebarVisible)
  // re-apply when the OS light/dark preference flips (only matters in 'system')
  const theme = useHang4r((s) => s.theme)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => applyTheme(theme)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
  // expand-to-focus also hides the sidebar for a true full-screen focus mode
  const expanded = useHang4r((s) => s.expandedSessionId)

  useEffect(() => {
    void init()
  }, [init])

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useHang4r.getState()
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      // ⌃` — toggle terminal panel (VS Code/Cursor); check before the
      // lowercase-letter branches since backtick isn't a letter
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        s.toggleTerminalPanel()
        return
      }
      // ⌥⌘B — toggle the focused tile's context panel (Cursor). Match on
      // e.code, not e.key: Option+B on macOS produces the character '∫'.
      if (e.altKey && e.metaKey && e.code === 'KeyB') {
        e.preventDefault()
        s.togglePanel()
        return
      }
      const k = e.key.toLowerCase()
      // ⌘K command palette
      if (k === 'f' && e.shiftKey) {
        e.preventDefault()
        s.openSearch() // ⌘⇧F — search in files (Cursor/VS Code)
      } else if (k === 'f') {
        // ⌘F — the SAME find bar in three scopes (round 13 ①). Monaco has its
        // own ⌘F editor command that opens our bar and eats the key before this
        // window handler, so a focused editor never reaches here — bail if it
        // somehow does. A focused terminal opens the bar scoped to that
        // terminal; otherwise it's the focused tile's conversation.
        const active = document.activeElement as HTMLElement | null
        if (active?.closest('.monaco-editor')) return
        const term = active?.closest('.terminal-view')
        if (term) {
          e.preventDefault()
          term.dispatchEvent(new CustomEvent('hang4r-find-toggle'))
          return
        }
        // browser CHROME focus → find-in-page for that pane (guest-PAGE focus is
        // handled by main's before-input-event; keys there never reach here)
        const browser = active?.closest('.browser-pane')
        if (browser) {
          e.preventDefault()
          browser.dispatchEvent(new CustomEvent('hang4r-find-toggle'))
          return
        }
        // NOTE: the EDITOR case is handled earlier by a CAPTURE-phase listener
        // (see below) that beats Monaco's own ⌘F — so if we reach here, no editor
        // owns it; fall through to the conversation find.
        const scroll = document.querySelector('.tile-focused .chat-scroll')
        if (scroll) {
          e.preventDefault()
          scroll.dispatchEvent(new CustomEvent('hang4r-find-toggle'))
        }
      } else if (k === 'p' && e.shiftKey) {
        e.preventDefault()
        s.toggleCommandPalette(true) // ⌘⇧P — command palette (Cursor/VS Code)
      } else if (k === 'k') {
        e.preventDefault()
        // iTerm2 muscle memory: ⌘K inside a focused terminal CLEARS it — the
        // palette keeps ⌘K everywhere else (and ⌘⇧P always)
        const termEl = (document.activeElement as HTMLElement | null)?.closest('.terminal-view')
        if (termEl) termEl.dispatchEvent(new CustomEvent('hang4r-clear'))
        else s.toggleCommandPalette()
      } else if (k === 'p') {
        e.preventDefault()
        s.toggleFileFinder(true) // ⌘P — quick file finder
      } else if (k === ',') {
        e.preventDefault()
        s.setSettingsOpen(true)
      } else if (k === 'b') {
        e.preventDefault()
        s.toggleSidebar()
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        const id = s.openSessionIds[Number(e.key) - 1]
        if (id) {
          e.preventDefault()
          s.focusSession(id)
        }
      } else if (e.shiftKey && k === 'e') {
        if (s.focusedSessionId) {
          e.preventDefault()
          s.toggleExpand(s.focusedSessionId)
        }
      } else if (k === 'w') {
        // close the pane item you're IN (editor file / terminal / browser tab), or
        // the whole session tile when focus is in the conversation — see helper
        e.preventDefault()
        closeFocusedScope()
      } else if (k === '.') {
        if (s.focusedSessionId) {
          e.preventDefault()
          void s.interrupt(s.focusedSessionId)
        }
      } else if (k === 'n') {
        // ⌘N makes a new untitled file when the Files pane is what you're working
        // in (its tree/editor is focused, OR you just opened it and its tab has
        // focus); anywhere else — the conversation, <body>, a terminal, the
        // browser — it opens the new-agent dialog. focusPane() encodes exactly
        // that, so ⌘N no longer makes a file while you type in the chat (Angel).
        if (focusPane() === 'editor' && s.scopedNewFile?.()) {
          e.preventDefault()
          return
        }
        const projectId =
          s.sessions.find((x) => x.id === s.focusedSessionId)?.projectId ?? s.projects[0]?.id
        if (projectId) {
          e.preventDefault()
          s.openNewSessionDialog(projectId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // native menu-bar item clicked → run the matching app command. The menu shows
  // each shortcut but doesn't REGISTER it (registerAccelerator:false in the main
  // menu), so the renderer stays the single owner of the KEYS; this handles the
  // CLICKS, dispatching the exact same store actions the shortcuts above do.
  useEffect(() => {
    return window.hang4r.onMenuCommand((command) => {
      const s = useHang4r.getState()
      switch (command) {
        case 'new-agent': {
          const projectId =
            s.sessions.find((x) => x.id === s.focusedSessionId)?.projectId ?? s.projects[0]?.id
          if (projectId) s.openNewSessionDialog(projectId)
          break
        }
        case 'new-workspace':
          void s.addProject()
          break
        case 'import-session':
          s.setImportSource('cursor')
          s.setCursorImportOpen(true)
          break
        case 'command-palette':
          s.toggleCommandPalette(true)
          break
        case 'quick-open':
          s.toggleFileFinder(true)
          break
        case 'search-files':
          s.openSearch()
          break
        case 'settings':
          s.setSettingsOpen(true)
          break
        case 'check-updates':
          // don't yank you into Settings — the title-bar pill shows the result
          // (checking → up-to-date / downloading / error), same as an auto-check
          void window.hang4r.checkForUpdates()
          break
        case 'toggle-sidebar':
          s.toggleSidebar()
          break
        case 'toggle-panel':
          s.togglePanel()
          break
        case 'toggle-terminal':
          s.toggleTerminalPanel()
          break
        case 'expand-pane':
          if (s.focusedSessionId) s.toggleExpand(s.focusedSessionId)
          break
        case 'interrupt':
          if (s.focusedSessionId) void s.interrupt(s.focusedSessionId)
          break
        case 'close':
          closeFocusedScope()
          break
      }
    })
  }, [])

  // ⌘F for the EDITOR, handled in CAPTURE so it beats Monaco's own per-editor ⌘F
  // command. That command fires for whichever editor has FOCUS — which, with
  // several files open, can be a HIDDEN one that kept focus, so ⌘F opened its
  // find bar buried behind the file you're looking at (Angel, repeatedly). Here
  // we route ⌘F to the editor actually VISIBLE in the focused tile, regardless of
  // focus, and stop the event so Monaco never sees it. Only claim ⌘F when focus
  // is inside an editor or nowhere specific — terminal/browser/composer/chat keep
  // their own ⌘F.
  useEffect(() => {
    const onFindCapture = (e: KeyboardEvent): void => {
      if (!(e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)) return
      if (e.key !== 'f' && e.key !== 'F') return
      const active = document.activeElement as HTMLElement | null
      // terminal/browser own their own ⌘F
      if (active?.closest('.terminal-view') || active?.closest('.browser-pane')) return
      // Route to the editor when focus is in the files/context area (the editor,
      // the file tree/tabs, anywhere in the context panel) OR nowhere specific.
      // If focus is in the chat composer/conversation instead, bail so the bubble
      // handler does a CHAT find. Only fires when a visible editor actually exists.
      const inEditorCtx =
        !!active?.closest('.code-editor') || !!active?.closest('.context-panel')
      // Only claim ⌘F for the editor when focus is genuinely INSIDE the editor /
      // context panel. When focus is anywhere else — the composer, the chat text,
      // or nowhere (clicking non-focusable conversation text drops focus to
      // <body>) — bail so the bubble handler routes ⌘F to the CONVERSATION find.
      // (Was: a `nowhere → editor` fallback grabbed body-focus, so clicking in the
      // conversation then ⌘F wrongly opened the editor's find bar — Angel.)
      if (!inEditorCtx) return
      const visible = Array.from(
        document.querySelectorAll<HTMLElement>('.tile-focused .context-panel .code-editor')
      ).find((el) => el.offsetParent !== null)
      if (!visible) return
      e.preventDefault()
      e.stopImmediatePropagation() // beat Monaco's per-editor ⌘F + our bubble handler
      visible.dispatchEvent(new CustomEvent('hang4r-editor-find'))
    }
    window.addEventListener('keydown', onFindCapture, true)
    return () => window.removeEventListener('keydown', onFindCapture, true)
  }, [])

  return (
    <div className="app">
      <div className="titlebar">
        <button
          className={'titlebar-sidebar-toggle' + (sidebarVisible ? '' : ' titlebar-sidebar-toggle-off')}
          title={sidebarVisible ? 'Hide Sidebar (⌘B)' : 'Show Sidebar (⌘B)'}
          onClick={() => useHang4r.getState().toggleSidebar()}
        >
          <Icon name="panel-left" size={15} />
        </button>
        <div className="titlebar-spacer" />
        <UpdatePill />
        <button className="titlebar-cmdk" title="Command palette (⌘⇧P or ⌘K)" onClick={() => useHang4r.getState().toggleCommandPalette(true)}>
          ⌘⇧P
        </button>
        <UsageBar />
      </div>
      <div className="app-body">
        {expanded ? null : sidebarVisible ? <Sidebar /> : <SidebarRail />}
        <Workspace />
      </div>
      <WorkingPanel />
      <NewSessionDialog />
      <CommandPalette />
      <FileFinder />
      <Settings />
      <QuitConfirm />
      <ContextMenu />
      <InputDialog />
      <ArchivedSessions />
      <CursorImport />
      <Lightbox />
    </div>
  )
}
