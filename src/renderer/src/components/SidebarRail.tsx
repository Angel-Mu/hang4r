import type { JSX } from 'react'
import { useHang4r } from '../state/store'
import { Icon, type IconName } from './Icon'

/**
 * Collapsed-sidebar icon rail (Cursor-style): a slim vertical strip of actions
 * instead of fully hiding the sidebar. Click the top chevron (or ⌘B) to expand.
 */
export function SidebarRail(): JSX.Element {
  const projects = useHang4r((s) => s.projects)
  const focusedId = useHang4r((s) => s.focusedSessionId)
  const sessions = useHang4r((s) => s.sessions)
  const focusedProjectId =
    sessions.find((x) => x.id === focusedId)?.projectId ?? projects[0]?.id ?? null

  const expand = (): void => useHang4r.getState().toggleSidebar()
  const item = (
    name: IconName,
    label: string,
    onClick: () => void,
    disabled = false
  ): JSX.Element => (
    <button className="rail-btn" title={label} disabled={disabled} onClick={onClick}>
      <Icon name={name} size={17} />
    </button>
  )

  return (
    <nav className="sidebar-rail" aria-label="Collapsed sidebar">
      <button className="rail-btn rail-expand" title="Expand sidebar (⌘B)" onClick={expand}>
        ⟩
      </button>
      {item(
        'sparkle',
        'New Agent',
        () =>
          focusedProjectId && useHang4r.getState().openNewSessionDialog(focusedProjectId),
        projects.length === 0
      )}
      {item('search', 'Search sessions', expand)}
      {item('folder', 'Add workspace', () => void useHang4r.getState().addProject())}
      {item('message', 'Import a session', () => useHang4r.getState().setCursorImportOpen(true))}
      <div className="rail-spacer" />
      {item('archive', 'Archived sessions', () => useHang4r.getState().setArchivedOpen(true))}
      {item('settings', 'Settings', () => useHang4r.getState().setSettingsOpen(true))}
    </nav>
  )
}
