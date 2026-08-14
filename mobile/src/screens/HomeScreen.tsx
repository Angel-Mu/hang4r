import { useEffect, useState, type JSX } from 'react'
import type { SessionMeta } from '@shared/protocol'
import { Icon } from '@shared/icons'
import { useApp } from '../state/store'
import { Drawer } from '../components/Drawer'
import { usePullToRefresh } from '../hooks/usePullToRefresh'

/** Mirrors the desktop sidebar: 10 sessions per workspace, then "Show more". */
const SESSIONS_PAGE = 10
const COLLAPSED_KEY = 'h4.collapsedProjects'

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

/** Desktop dot semantics: idle = invisible, green pulse = WORKING, amber
 *  pulse = awaiting your response, accent = finished unseen, red = error. */
function dotClass(session: SessionMeta, pending: number, attention: boolean): string {
  const unseenDone = attention && session.status === 'idle' && pending === 0
  return (
    `status-dot status-${session.status}` +
    (pending > 0 ? ' status-awaiting' : '') +
    (unseenDone ? ' status-unseen' : '')
  )
}

/** Trailing text only for states that need words; the dot carries the rest. */
function RowState({
  session,
  pending
}: {
  session: SessionMeta
  pending: number
}): JSX.Element | null {
  if (pending > 0) return <span className="session-status needs-you">needs you</span>
  if (session.status === 'error') return <span className="session-status errored">error</span>
  return null
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
  const refreshing = useApp((s) => s.refreshing)
  const openSession = useApp((s) => s.openSession)
  const setScreen = useApp((s) => s.setScreen)
  const error = useApp((s) => s.error)
  const pendingApprovals = useApp((s) => s.pendingApprovals)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [pageLimits, setPageLimits] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const filterLower = filter.trim().toLowerCase()
  const { ref: listRef, pull, active: ptrActive } = usePullToRefresh<HTMLDivElement>(refresh)

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
  const live = sessions.filter(
    (s) =>
      s.status !== 'archived' && (!filterLower || s.title.toLowerCase().includes(filterLower))
  )
  const lastActivity = (projectId: string): number =>
    Math.max(0, ...live.filter((s) => s.projectId === projectId).map((s) => s.updatedAt))
  const orderedProjects = [...projects]
    .filter((p) => live.some((s) => s.projectId === p.id))
    .sort((a, b) => lastActivity(b.id) - lastActivity(a.id))

  const spinning = refreshing || ptrActive

  return (
    <div className="screen home-screen">
      <header className="topbar">
        <button className="brand-btn" onClick={() => setDrawerOpen(true)} aria-label="Menu">
          <span className="brand-mark">▐</span>
          <span className="brand-name">hang4r</span>
          <Icon name="chevron-down" size={13} />
        </button>
        <ConnDot />
        <button
          className="btn btn-primary topbar-new"
          aria-label="New agent"
          onClick={() => setScreen('new')}
        >
          +
        </button>
      </header>
      {error && <p className="banner banner-error">{error}</p>}
      {conn !== 'online' && (
        <p className="banner">
          {conn === 'relay'
            ? 'Your computer is offline — showing the last known sessions. Everything reconnects automatically.'
            : 'Connecting… — showing the last known sessions.'}
        </p>
      )}
      <div className="home-search">
        <input
          className="home-search-input"
          type="search"
          placeholder="Search sessions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      <div
        className={'ptr' + (spinning || pull > 0 ? ' ptr-visible' : '')}
        style={pull > 0 ? { height: pull } : undefined}
      >
        <span className={'ptr-spinner' + (spinning || pull >= 60 ? ' ptr-armed' : '')}>
          <Icon name="refresh" size={17} />
        </span>
      </div>
      <main className="home-list" ref={listRef}>
        {orderedProjects.map((p) => {
          const own = live
            .filter((s) => s.projectId === p.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)
          const isCollapsed = collapsed.has(p.id) && !filterLower
          const limit = pageLimits[p.id] ?? SESSIONS_PAGE
          const visible = filterLower ? own : own.slice(0, limit)
          const needsYou = own.filter((s) => (pendingApprovals[s.id] ?? 0) > 0).length
          return (
            <section key={p.id} className="project-group">
              <button className="project-header" onClick={() => toggleCollapsed(p.id)}>
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                <span className="project-name">{p.name}</span>
                {isCollapsed && needsYou > 0 && (
                  <span className="needs-you-count">{needsYou} need you</span>
                )}
                <span className="project-count">{own.length}</span>
              </button>
              {!isCollapsed && (
                <>
                  {visible.map((s) => (
                    <button
                      key={s.id}
                      className="session-row"
                      onClick={() => void openSession(s.id)}
                    >
                      <span
                        className={dotClass(s, pendingApprovals[s.id] ?? 0, !!attention[s.id])}
                      />
                      <span className={`backend-glyph backend-${s.backend}`} title={s.backend}>
                        <Icon name={s.backend} size={15} />
                      </span>
                      <span className="session-title">{s.title}</span>
                      <RowState session={s} pending={pendingApprovals[s.id] ?? 0} />
                    </button>
                  ))}
                  {own.length > limit && !filterLower && (
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
            {filterLower
              ? 'No sessions match your search.'
              : 'No live sessions. Start one with ＋ or on your computer — it shows up instantly.'}
          </p>
        )}
      </main>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  )
}
