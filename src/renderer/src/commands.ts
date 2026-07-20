import { useHang4r } from './state/store'
import { THEMES } from './theme'

export interface Command {
  id: string
  title: string
  shortcut?: string
  group: string
  run: () => void
  /** dynamic subtitle (e.g. session title) */
  subtitle?: string
}

/** Build the full command list from current app state (for ⌘K palette). */
export function buildCommands(): Command[] {
  const s = useHang4r.getState()
  const focusedProject =
    s.sessions.find((x) => x.id === s.focusedSessionId)?.projectId ?? s.projects[0]?.id ?? null
  const focused = s.focusedSessionId

  const cmds: Command[] = [
    {
      id: 'new-agent',
      title: 'New Agent…',
      shortcut: '⌘N',
      group: 'Agents',
      run: () => focusedProject && s.openNewSessionDialog(focusedProject)
    },
    {
      id: 'add-project',
      title: 'Add Project Folder…',
      group: 'Agents',
      run: () => void s.addProject()
    },
    { id: 'archived', title: 'Archived Sessions…', group: 'Agents', run: () => s.setArchivedOpen(true) },
    { id: 'import-session', title: 'Import a Session…', group: 'Agents', run: () => s.setCursorImportOpen(true) },
    { id: 'settings', title: 'Open Settings', shortcut: '⌘,', group: 'App', run: () => s.setSettingsOpen(true) },
    // escape hatch for a wedged UI — same as VS Code's "Developer: Reload Window"
    {
      id: 'reload-window',
      title: 'Reload Window',
      shortcut: '⌥⌘R',
      group: 'App',
      run: () => location.reload()
    },
    {
      id: 'app-devtools',
      title: 'Developer: Toggle App DevTools',
      group: 'App',
      run: () => void window.hang4r.toggleAppDevTools()
    },
    { id: 'settings-json-app', title: 'Open Settings (settings.json)', group: 'App', run: () => s.openSettingsAt('settings.json') },
    { id: 'toggle-sidebar', title: 'Toggle Sidebar', shortcut: '⌘B', group: 'View', run: () => s.toggleSidebar() },
    { id: 'toggle-terminal', title: 'Toggle Terminal Panel', shortcut: '⌃`', group: 'View', run: () => s.toggleTerminalPanel() },
    { id: 'search-files', title: 'Search in Files', shortcut: '⌘⇧F', group: 'View', run: () => s.openSearch() }
  ]

  // theme switching — one command per theme (matches on the "Theme" group too)
  for (const t of THEMES) {
    cmds.push({
      id: 'theme-' + t.value,
      title: `Theme: ${t.label}`,
      group: 'Theme',
      run: () => s.setTheme(t.value)
    })
  }

  // per-session commands for the focused session
  if (focused) {
    const sess = s.sessions.find((x) => x.id === focused)
    const t = sess ? `“${sess.title}”` : ''
    cmds.push(
      { id: 'expand', title: `Expand / Restore Pane ${t}`, shortcut: '⌘⇧E', group: 'View', run: () => s.toggleExpand(focused) },
      { id: 'fork', title: `Duplicate / Fork ${t}`, group: 'Agents', run: () => void s.duplicateSession(focused) },
      { id: 'retry', title: `Retry Last Message ${t}`, group: 'Agents', run: () => void s.retrySession(focused) },
      { id: 'interrupt', title: `Stop Agent ${t}`, shortcut: '⌘.', group: 'Agents', run: () => void s.interrupt(focused) },
      { id: 'close-tile', title: `Close Pane ${t}`, shortcut: '⌘W', group: 'View', run: () => s.closeTile(focused) }
    )
  }

  // jump-to-session for every session
  for (const sess of s.sessions) {
    cmds.push({
      id: 'jump-' + sess.id,
      title: `Go to: ${sess.title}`,
      subtitle: sess.backend,
      group: 'Go to Session',
      run: () => void s.openSession(sess.id)
    })
  }
  return cmds
}
