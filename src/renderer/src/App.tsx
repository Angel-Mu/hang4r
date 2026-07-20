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

/** Titlebar update pill — appears only once the auto-checker finds something.
 *  Downloads happen silently in the background; this surfaces the result and
 *  offers a one-click restart. Never auto-closes the app. */
function UpdatePill(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    void window.hang4r.getUpdateStatus().then(setStatus)
    return window.hang4r.onUpdateStatus(setStatus)
  }, [])
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
        // scoped close: focused editor file / active terminal first, else the tile
        e.preventDefault()
        const closedScope = s.scopedClose?.()
        if (!closedScope && s.focusedSessionId) s.closeTile(s.focusedSessionId)
      } else if (k === '.') {
        if (s.focusedSessionId) {
          e.preventDefault()
          void s.interrupt(s.focusedSessionId)
        }
      } else if (k === 'n') {
        // in the Files panel, ⌘N makes a new untitled file (VS Code); otherwise
        // it opens the new-session dialog
        if (s.scopedNewFile?.()) {
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
