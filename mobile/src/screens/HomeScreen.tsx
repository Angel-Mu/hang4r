import { useEffect, useState, type JSX } from 'react'
import type { SessionMeta } from '@shared/protocol'
import { Icon } from '@shared/icons'
import { useApp } from '../state/store'

/** Mirrors the desktop sidebar: 10 sessions per workspace, then "Show more". */
const SESSIONS_PAGE = 10
const COLLAPSED_KEY = 'h4.collapsedProjects'

const STATUS_LABEL: Record<SessionMeta['status'], string> = {
  starting: 'starting',
  running: 'working',
  idle: 'idle',
  error: 'error',
  archived: 'archived'
}

function ConnDot(): JSX.Element {
  const conn = useApp((s) => s.conn)
  const label =
    conn === 'online' ? 'connected' : conn === 'relay' ? 'desktop offline' : 'connecting…'
  return (
    <span className={`conn-dot conn-${conn}`} title={label}>
      <i />
      {label}
    </span>
  )
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function HomeScreen(): JSX.Element {
  const conn = useApp((s) => s.conn)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const attention = useApp((s) => s.attention)
  const refresh = useApp((s) => s.refresh)
  const openSession = useApp((s) => s.openSession)
  const setScreen = useApp((s) => s.setScreen)
  const error = useApp((s) => s.error)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [pageLimits, setPageLimits] = useState<Record<string, number>>({})

  useEffect(() => {
    if (conn === 'online') void refresh()
  }, [conn, refresh])

  const toggleCollapsed = (projectId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  }

  // desktop sidebar order: workspaces by last activity, sessions by updatedAt
  const live = sessions.filter((s) => s.status !== 'archived')
  const lastActivity = (projectId: string): number =>
    Math.max(0, ...live.filter((s) => s.projectId === projectId).map((s) => s.updatedAt))
  const orderedProjects = [...projects]
    .filter((p) => live.some((s) => s.projectId === p.id))
    .sort((a, b) => lastActivity(b.id) - lastActivity(a.id))

  return (
    <div className="screen home-screen">
      <header className="topbar">
        <span className="topbar-title">hang4r</span>
        <ConnDot />
        <button
          className="btn btn-ghost topbar-action"
          aria-label="Usage"
          onClick={() => setScreen('usage')}
        >
          <Icon name="gauge" size={19} />
        </button>
        <button
          className="btn btn-ghost topbar-action"
          aria-label="Settings"
          onClick={() => setScreen('settings')}
        >
          <Icon name="settings" size={19} />
        </button>
        <button
          className="btn btn-primary topbar-new"
          aria-label="New agent"
          onClick={() => setScreen('new')}
        >
          +
        </button>
      </header>
      {error && <p className="banner banner-error">{error}</p>}
      {conn === 'relay' && (
        <p className="banner">
          Your computer is offline. Sessions appear as soon as hang4r desktop reconnects.
        </p>
      )}
      <main className="home-list">
        {orderedProjects.map((p) => {
          const own = live
            .filter((s) => s.projectId === p.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)
          const isCollapsed = collapsed.has(p.id)
          const limit = pageLimits[p.id] ?? SESSIONS_PAGE
          const visible = own.slice(0, limit)
          const awaiting = own.filter((s) => attention[s.id]).length
          return (
            <section key={p.id} className="project-group">
              <button className="project-header" onClick={() => toggleCollapsed(p.id)}>
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                <span className="project-name">{p.name}</span>
                <span className="project-count">
                  {own.length}
                  {isCollapsed && awaiting > 0 && <i className="attention-dot"> ●</i>}
                </span>
              </button>
              {!isCollapsed && (
                <>
                  {visible.map((s) => (
                    <button
                      key={s.id}
                      className="session-row"
                      onClick={() => void openSession(s.id)}
                    >
                      <span className={`status-dot status-${s.status}`} />
                      <span className="session-title">{s.title}</span>
                      {attention[s.id] && <span className="attention-dot">●</span>}
                      <span className={`backend-glyph backend-${s.backend}`} title={s.backend}>
                        <Icon name={s.backend} size={15} />
                      </span>
                      <span className="session-status">{STATUS_LABEL[s.status]}</span>
                    </button>
                  ))}
                  {own.length > limit && (
                    <button
                      className="show-more"
                      onClick={() =>
                        setPageLimits((prev) => ({ ...prev, [p.id]: limit + SESSIONS_PAGE }))
                      }
                    >
                      Show {Math.min(SESSIONS_PAGE, own.length - limit)} more
                    </button>
                  )}
                </>
              )}
            </section>
          )
        })}
        {conn === 'online' && live.length === 0 && (
          <p className="empty-note">
            No live sessions. Start one here with ＋ or on your computer — it shows up instantly.
          </p>
        )}
      </main>
      <footer className="home-footer">
        <button className="btn btn-ghost home-refresh" onClick={() => void refresh()}>
          <Icon name="refresh" size={15} /> Refresh
        </button>
      </footer>
    </div>
  )
}
