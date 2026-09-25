import { useEffect, useRef, useState, type JSX } from 'react'
import type { SessionMeta } from '@shared/protocol'
import { Icon } from '@shared/icons'
import { orderProjects, orderSessions } from '@shared/sidebarOrder'
import { relativeTime } from '@shared/relativeTime'
import { isFinishedUnseen, useApp } from '../state/store'
import { Drawer } from '../components/Drawer'
import { SessionActionSheet } from '../components/SessionActionSheet'
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
 *  pulse = awaiting your response, accent = finished unseen, red = error,
 *  slow cyan pulse = turn over but still working (amber and accent win). */
function dotClass(
  session: SessionMeta,
  pending: number,
  unseen: boolean,
  stillWorking: boolean
): string {
  const awaiting = pending > 0
  const unseenDone = unseen && session.status === 'idle' && !awaiting
  return (
    `status-dot status-${session.status}` +
    (awaiting ? ' status-awaiting' : '') +
    (unseenDone ? ' status-unseen' : '') +
    (stillWorking && !awaiting && !unseenDone ? ' status-pending' : '')
  )
}

/** Trailing text/glyphs; the dot carries the base state. */
function RowState({
  session,
  pending,
  unseen
}: {
  session: SessionMeta
  pending: number
  unseen: boolean
}): JSX.Element | null {
  if (pending > 0) return <span className="session-status needs-you">needs you</span>
  if (session.status === 'error') return <span className="session-status errored">error</span>
  if (unseen && session.status === 'idle')
    return (
      <span className="session-bell" title="Finished — open to view">
        <Icon name="bell" size={13} />
      </span>
    )
  return null
}

/** null = never toggled on this phone (the desktop's collapse applies) */
function loadCollapsed(): Set<string> | null {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return raw === null ? null : new Set(JSON.parse(raw) as string[])
  } catch {
    return null
  }
}

export function HomeScreen(): JSX.Element {
  const conn = useApp((s) => s.conn)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const attention = useApp((s) => s.attention)
  const desktopUnseen = useApp((s) => s.desktopUnseen)
  const finishedAt = useApp((s) => s.finishedAt)
  const refresh = useApp((s) => s.refresh)
  const refreshing = useApp((s) => s.refreshing)
  const openSession = useApp((s) => s.openSession)
  const setScreen = useApp((s) => s.setScreen)
  const error = useApp((s) => s.error)
  const pendingApprovals = useApp((s) => s.pendingApprovals)
  const pinned = useApp((s) => s.pinned)
  const seenAt = useApp((s) => s.seenAt)
  const unreadOverrides = useApp((s) => s.unreadOverrides)
  const liveWork = useApp((s) => s.liveWork)
  // keeps "now / 5m / 2h" honest while the list sits open
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(iv)
  }, [])
  const unseenOf = (id: string): boolean =>
    isFinishedUnseen({ desktopUnseen, attention, finishedAt, seenAt, unreadOverrides }, id)
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  // long-press opens the row's actions; the synthetic click that follows must
  // not open the row
  const suppressClick = useRef(false)
  const pressTimer = useRef<number | null>(null)
  const startPress = (sessionId: string): void => {
    pressTimer.current = window.setTimeout(() => {
      suppressClick.current = true
      setSheetFor(sessionId)
    }, 500)
  }
  const endPress = (): void => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
    // not every WebView follows a long-press with a click; don't eat the next tap
    if (suppressClick.current) window.setTimeout(() => (suppressClick.current = false), 400)
  }
  const layout = useApp((s) => s.desktopLayout)
  const [localCollapsed, setLocalCollapsed] = useState<Set<string> | null>(loadCollapsed)
  const collapsed = localCollapsed ?? new Set(layout?.collapsedProjects ?? [])
  const [pageLimits, setPageLimits] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const filterLower = filter.trim().toLowerCase()
  const { ref: listRef, pull, active: ptrActive } = usePullToRefresh<HTMLDivElement>(refresh)

  useEffect(() => {
    if (conn === 'online') void refresh()
  }, [conn, refresh])

  const toggleCollapsed = (projectId: string): void => {
    const next = new Set(collapsed)
    if (next.has(projectId)) next.delete(projectId)
    else next.add(projectId)
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    setLocalCollapsed(next)
  }

  const unarchived = sessions.filter((s) => s.status !== 'archived')
  const live = unarchived.filter(
    (s) => !filterLower || s.title.toLowerCase().includes(filterLower)
  )
  // the desktop's own order and pins, with this phone's pins on top; an older
  // desktop can't say, so workspaces go by latest activity and empty ones hide
  const isPinned = (id: string): boolean =>
    pinned.includes(id) || !!layout?.pinnedSessions.includes(id)
  const orderedProjects = layout
    ? orderProjects(projects, unarchived, layout).filter(
        (p) => !filterLower || live.some((s) => s.projectId === p.id)
      )
    : orderProjects(
        projects.filter((p) => live.some((s) => s.projectId === p.id)),
        live,
        { pinnedProjects: [], projectOrder: [], projectSort: 'recent' }
      )

  const spinning = refreshing || ptrActive
  const sheetSession = sheetFor ? sessions.find((x) => x.id === sheetFor) : undefined

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
          const own = orderSessions(
            live.filter((s) => s.projectId === p.id),
            isPinned
          )
          const isCollapsed = collapsed.has(p.id) && !filterLower
          const limit = pageLimits[p.id] ?? SESSIONS_PAGE
          const visible = filterLower ? own : own.slice(0, limit)
          const needsYou = own.filter((s) => (pendingApprovals[s.id] ?? 0) > 0).length
          const errors = own.filter((s) => s.status === 'error').length
          const done = own.filter(
            (s) => unseenOf(s.id) && s.status === 'idle' && !(pendingApprovals[s.id] ?? 0)
          ).length
          return (
            <section key={p.id} className="project-group">
              <button className="project-header" onClick={() => toggleCollapsed(p.id)}>
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                <span className="project-name">{p.name}</span>
                {layout?.pinnedProjects.includes(p.id) && (
                  <span className="project-pin" title="Pinned workspace">
                    <Icon name="pin" size={12} />
                  </span>
                )}
                {isCollapsed && needsYou > 0 && (
                  <span className="needs-you-count">{needsYou} need you</span>
                )}
                {isCollapsed && errors > 0 && (
                  <span className="project-flag project-flag-error">
                    {errors} error{errors > 1 ? 's' : ''}
                  </span>
                )}
                {isCollapsed && done > 0 && (
                  <span className="project-flag project-flag-finished">{done} done</span>
                )}
                <span className="project-count">{own.length}</span>
              </button>
              {!isCollapsed && (
                <>
                  {visible.map((s) => (
                    <button
                      key={s.id}
                      className="session-row"
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false
                          return
                        }
                        void openSession(s.id)
                      }}
                      onTouchStart={() => startPress(s.id)}
                      onTouchEnd={endPress}
                      onTouchMove={endPress}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setSheetFor(s.id)
                      }}
                    >
                      <span
                        className={dotClass(
                          s,
                          pendingApprovals[s.id] ?? 0,
                          unseenOf(s.id),
                          liveWork.includes(s.id)
                        )}
                      />
                      <span className={`backend-glyph backend-${s.backend}`} title={s.backend}>
                        <Icon name={s.backend} size={15} />
                      </span>
                      <span className="session-title">{s.title}</span>
                      <RowState
                        session={s}
                        pending={pendingApprovals[s.id] ?? 0}
                        unseen={unseenOf(s.id)}
                      />
                      {isPinned(s.id) && (
                        <span className="session-pin" title="Pinned">
                          <Icon name="pin" size={12} />
                        </span>
                      )}
                      <span className="session-time">{relativeTime(s.updatedAt)}</span>
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
      {sheetSession && (
        <SessionActionSheet
          session={sheetSession}
          onClose={() => {
            suppressClick.current = false
            setSheetFor(null)
          }}
        />
      )}
    </div>
  )
}
