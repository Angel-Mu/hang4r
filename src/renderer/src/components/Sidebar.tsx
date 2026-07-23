import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  BackendId,
  ClaudeUsageSnapshot,
  CodexUsageSnapshot,
  CursorUsageSnapshot,
  ModelChoice,
  SessionMeta
} from '../../../shared/protocol'
import { useHang4r, isAwaitingPermission, isAwaitingQuestion } from '../state/store'
import { contextWindow } from '../contextWindow'
import { FALLBACK_CODEX_MODELS } from '../modelChoices'
import { Icon, type IconName } from './Icon'

const STATUS_LABEL: Record<SessionMeta['status'], string> = {
  starting: 'starting',
  running: 'running',
  idle: 'idle',
  error: 'error',
  archived: 'archived'
}

// Per-backend identity glyph (defined in Icon.tsx; tinted via CSS).
const BACKEND_ICON: Record<BackendId, IconName> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor'
}
const BACKEND_LABEL: Record<BackendId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor'
}

function relativeTime(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return `${Math.floor(d / 30)}mo`
}

export function Sidebar(): JSX.Element {
  const projects = useHang4r((s) => s.projects)
  const sessions = useHang4r((s) => s.sessions)
  const focusedId = useHang4r((s) => s.focusedSessionId)
  const addProject = useHang4r((s) => s.addProject)
  const pinnedProjectIds = useHang4r((s) => s.pinnedProjectIds)
  const projectSort = useHang4r((s) => s.projectSort)
  const sessionUsage = useHang4r((s) => s.sessionUsage)
  const [cursorAvailable, setCursorAvailable] = useState(false)
  const [claudeImportAvailable, setClaudeImportAvailable] = useState(false)
  const [codexImportAvailable, setCodexImportAvailable] = useState(false)
  const [codexModels, setCodexModels] = useState<ModelChoice[]>(FALLBACK_CODEX_MODELS)
  // per-workspace collapse (open/closed folder), like Cursor
  const projectOrder = useHang4r((s) => s.projectOrder)
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapsed = (id: string): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  useEffect(() => {
    void window.hang4r.cursorAvailable().then(setCursorAvailable)
    void window.hang4r.claudeImportAvailable().then(setClaudeImportAvailable)
    void window.hang4r.codexImportAvailable().then(setCodexImportAvailable)
    void window.hang4r.listCodexModels().then(setCodexModels).catch(() => setCodexModels(FALLBACK_CODEX_MODELS))
  }, [])
  const openNewSession = useHang4r((s) => s.openNewSessionDialog)
  const openSession = useHang4r((s) => s.openSession)
  const archiveSession = useHang4r((s) => s.archiveSession)
  const duplicateSession = useHang4r((s) => s.duplicateSession)
  const retrySession = useHang4r((s) => s.retrySession)
  const renameSession = useHang4r((s) => s.renameSession)
  const openContextMenu = useHang4r((s) => s.openContextMenu)
  const pinned = useHang4r((s) => s.pinnedSessionIds)
  const togglePin = useHang4r((s) => s.togglePin)
  const filter = useHang4r((s) => s.sessionFilter)
  const setFilter = useHang4r((s) => s.setSessionFilter)
  const transcripts = useHang4r((s) => s.transcripts)

  const isPinned = (id: string): boolean => pinned.includes(id)
  // Amber "waiting on you" state: the session's transcript has a permission
  // request the user hasn't answered yet. SessionMeta.status can't express this
  // (it's still 'running'), so we read the live transcript here. Delegates to
  // isAwaitingPermission — the one predicate shared with the notification
  // pipeline's trigger condition (see store.ts).
  const awaitingPermission = (id: string): boolean =>
    isAwaitingPermission(transcripts[id]) || isAwaitingQuestion(transcripts[id])

  const sessionMenu = (e: React.MouseEvent, id: string): void => {
    e.preventDefault()
    const sess = sessions.find((x) => x.id === id)
    const isWorktree = sess?.environment === 'worktree'
    // Worktree cleanup that KEEPS the session + its conversation (unlike Archive,
    // which hides it): Drop frees the worktree on disk and stops hang4r rebuilding
    // it on open; Recreate re-provisions it to continue working (Angel).
    const worktreeItems = isWorktree
      ? [
          { separator: true, label: '' },
          sess?.worktreeDropped
            ? { label: 'Recreate worktree', onClick: () => void window.hang4r.recreateWorktree(id) }
            : {
                label: 'Drop worktree (keep conversation)',
                onClick: () => void window.hang4r.dropWorktree(id)
              }
        ]
      : []
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Open', onClick: () => void openSession(id) },
      { label: 'Open in Split', onClick: () => void openSession(id, { split: true }) },
      { separator: true, label: '' },
      {
        label: 'Rename…',
        onClick: () => {
          void useHang4r
            .getState()
            .showPrompt('Rename session', sessions.find((x) => x.id === id)?.title ?? '')
            .then((name) => {
              if (name?.trim()) void renameSession(id, name.trim())
            })
        }
      },
      { label: isPinned(id) ? 'Unpin' : 'Pin to top', onClick: () => togglePin(id) },
      { label: 'Duplicate / Fork', onClick: () => void duplicateSession(id) },
      { label: 'Retry Last Message', onClick: () => void retrySession(id) },
      ...worktreeItems,
      { separator: true, label: '' },
      { label: 'Archive', danger: true, onClick: () => void archiveSession(id) }
    ])
  }

  // resizable width, persisted
  const [width, setWidth] = useState(260)
  const draggingRef = useRef(false)
  useEffect(() => {
    void window.hang4r.getSetting('sidebarWidth').then((v) => {
      const n = Number(v)
      if (n >= 180 && n <= 520) setWidth(n)
    })
  }, [])
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      setWidth(Math.max(180, Math.min(520, e.clientX)))
    }
    const up = (): void => {
      if (draggingRef.current) {
        draggingRef.current = false
        void window.hang4r.setSetting('sidebarWidth', String(width))
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [width])

  const filterLower = filter.trim().toLowerCase()

  // workspaces ordered: pinned first, then by the chosen sort
  const lastActivity = (projectId: string): number =>
    Math.max(0, ...sessions.filter((s) => s.projectId === projectId).map((s) => s.updatedAt))
  const orderIndex = (id: string): number => {
    const i = projectOrder.indexOf(id)
    return i === -1 ? Number.POSITIVE_INFINITY : i
  }
  const orderedProjects = [...projects].sort((a, b) => {
    const ap = pinnedProjectIds.includes(a.id)
    const bp = pinnedProjectIds.includes(b.id)
    if (ap !== bp) return ap ? -1 : 1
    // manual drag order wins; unordered workspaces fall back to the chosen sort
    const ai = orderIndex(a.id)
    const bi = orderIndex(b.id)
    if (ai !== bi) return ai - bi
    return projectSort === 'name'
      ? a.name.localeCompare(b.name)
      : lastActivity(b.id) - lastActivity(a.id)
  })
  // drag-reorder: persist the visible order with the dragged workspace moved
  const reorderProject = (draggedId: string, targetId: string, before: boolean): void => {
    if (draggedId === targetId) return
    const ids = orderedProjects.map((p) => p.id).filter((id) => id !== draggedId)
    const ti = ids.indexOf(targetId)
    ids.splice(before ? ti : ti + 1, 0, draggedId)
    useHang4r.getState().setProjectOrder(ids)
  }
  const orderSessions = (list: SessionMeta[]): SessionMeta[] =>
    list
      .filter((s) => !filterLower || s.title.toLowerCase().includes(filterLower))
      .sort((a, b) => {
        const pa = isPinned(a.id) ? 1 : 0
        const pb = isPinned(b.id) ? 1 : 0
        if (pa !== pb) return pb - pa // pinned first
        return b.updatedAt - a.updatedAt // then most-recent
      })

  const focusedProjectId =
    sessions.find((x) => x.id === focusedId)?.projectId ?? projects[0]?.id ?? null

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        {/* decorative brand mark only — collapsing the sidebar lives solely in
            the titlebar toggle next to the traffic lights (Angel's call) */}
        <span className="sidebar-toggle sidebar-mark" aria-hidden="true">
          ▐
        </span>
        <span className="app-title">hang4r</span>
        <button className="ghost-btn" title="Add workspace folder" onClick={addProject}>
          + Workspace
        </button>
      </div>

      <button
        className="new-agent-btn"
        disabled={projects.length === 0}
        title="Start a new agent (⌘N)"
        onClick={() => openNewSession(focusedProjectId ?? projects[0]?.id)}
      >
        <Icon name="sparkle" size={13} /> New Agent
      </button>

      <input
        className="session-search"
        placeholder="Search sessions…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="sidebar-body">
        {projects.length === 0 && (
          <div className="sidebar-empty">
            <p>No workspaces yet.</p>
            <button className="primary-btn" onClick={addProject}>
              Add your first workspace
            </button>
          </div>
        )}
        {projects.length > 0 && (
          <div className="workspaces-head">
            <span>Workspaces</span>
            <button
              className="ghost-btn workspaces-sort"
              title={`Sort by ${projectSort === 'name' ? 'recent activity' : 'name'}`}
              onClick={() =>
                useHang4r.getState().setProjectSort(projectSort === 'name' ? 'recent' : 'name')
              }
            >
              {projectSort === 'name' ? 'A→Z' : '⧗'}
            </button>
          </div>
        )}
        {filterLower &&
          !sessions.some((s) => s.title.toLowerCase().includes(filterLower)) && (
            <div className="filter-empty">
              No sessions match “{filter.trim()}”
            </div>
          )}
        {orderedProjects.map((project) => {
          const projectSessions = orderSessions(sessions.filter((s) => s.projectId === project.id))
          if (filterLower && projectSessions.length === 0) return null
          // same predicate as the per-row badge, aggregated — a collapsed
          // workspace can't hide sessions that need you.
          const awaitingCount = projectSessions.filter((s) => awaitingPermission(s.id)).length
          const errorCount = projectSessions.filter((s) => s.status === 'error').length
          return (
            <div key={project.id} className="project-group">
              <div
                className={
                  'project-row' +
                  (collapsed.has(project.id) ? ' project-row-collapsed' : '') +
                  (dropTarget?.id === project.id
                    ? dropTarget.before
                      ? ' drop-before'
                      : ' drop-after'
                    : '')
                }
                title={collapsed.has(project.id) ? 'Expand workspace' : 'Collapse workspace'}
                onClick={() => toggleCollapsed(project.id)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-hang4r-project', project.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('application/x-hang4r-project')) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  setDropTarget({ id: project.id, before: e.clientY < r.top + r.height / 2 })
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget === e.target) setDropTarget(null)
                }}
                onDrop={(e) => {
                  const dragged = e.dataTransfer.getData('application/x-hang4r-project')
                  if (dragged) {
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    reorderProject(dragged, project.id, e.clientY < r.top + r.height / 2)
                  }
                  setDropTarget(null)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const store = useHang4r.getState()
                  const pinned = pinnedProjectIds.includes(project.id)
                  store.openContextMenu(e.clientX, e.clientY, [
                    {
                      label: pinned ? 'Unpin workspace' : 'Pin workspace to top',
                      onClick: () => store.togglePinProject(project.id)
                    },
                    { label: 'New agent session', onClick: () => openNewSession(project.id) },
                    { separator: true, label: '' },
                    {
                      label: 'Remove workspace',
                      danger: true,
                      onClick: () => void store.removeProject(project.id)
                    }
                  ])
                }}
              >
                <span className="project-folder" aria-hidden="true">
                  <Icon name={collapsed.has(project.id) ? 'folder' : 'folder-open'} size={16} />
                </span>
                <span className="project-name" title={project.path}>
                  {project.name}
                </span>
                {collapsed.has(project.id) && awaitingCount > 0 && (
                  <span
                    className="project-flag project-flag-action"
                    title={`${awaitingCount} session${awaitingCount > 1 ? 's' : ''} waiting for your response`}
                  >
                    {awaitingCount} need you
                  </span>
                )}
                {collapsed.has(project.id) && errorCount > 0 && (
                  <span
                    className="project-flag project-flag-error"
                    title={`${errorCount} session${errorCount > 1 ? 's' : ''} failed`}
                  >
                    {errorCount} error{errorCount > 1 ? 's' : ''}
                  </span>
                )}
                {pinnedProjectIds.includes(project.id) && (
                  <span className="project-pin" title="Pinned workspace">
                    <Icon name="pin" size={13} />
                  </span>
                )}
                <button
                  className="ghost-btn project-add"
                  title="New agent session in this project"
                  onClick={(e) => {
                    e.stopPropagation()
                    openNewSession(project.id)
                  }}
                >
                  +
                </button>
              </div>
              {!collapsed.has(project.id) && projectSessions.length > 0 && (
                <div className="project-sessions">
                  {projectSessions.map((session) => {
                    const awaiting = awaitingPermission(session.id)
                    // idle => no visible dot (kept in the DOM, transparent, for
                    // alignment + e2e); permission-wait overrides to amber.
                    const dotClass =
                      `status-dot status-${session.status}` + (awaiting ? ' status-awaiting' : '')
                    const dotTitle = awaiting ? 'waiting for your response' : STATUS_LABEL[session.status]
                    return (
                      <div
                        key={session.id}
                        className={
                          'session-row' + (session.id === focusedId ? ' session-row-focused' : '')
                        }
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/x-hang4r-session', session.id)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        // click: open in the focused pane · ⌘/ctrl-click: open in a split
                        onClick={(e) => openSession(session.id, { split: e.metaKey || e.ctrlKey })}
                        onContextMenu={(e) => sessionMenu(e, session.id)}
                      >
                        <span className={dotClass} title={dotTitle} />
                        <span
                          className={'session-backend backend-' + session.backend}
                          title={BACKEND_LABEL[session.backend]}
                        >
                          <Icon name={BACKEND_ICON[session.backend]} size={14} />
                        </span>
                        <span className="session-title" title={session.lastError ?? session.title}>
                          {session.title}
                        </span>
                        {/* meta + hover actions share one grid cell (session-trailing) so
                            the actions pill is sized/positioned to exactly the meta
                            cluster's own footprint, however narrow — it can no longer
                            bleed past it into the title on hover. */}
                        <span className="session-trailing">
                          <span className="session-meta">
                            {awaiting && (
                              <span className="session-flag session-flag-action" title="Needs your response">
                                ⏸
                              </span>
                            )}
                            {!awaiting && session.status === 'error' && (
                              <span
                                className="session-flag session-flag-error"
                                title={session.lastError ?? 'Turn failed'}
                              >
                                ✗
                              </span>
                            )}
                            {(() => {
                              // context indicator: silent until it matters (≥80%), then a
                              // compact pill — the full gauge lives in the session tile
                              const usage = sessionUsage[session.id]
                              const ctx = usage?.contextTokens ?? 0
                              if (ctx <= 0) return null
                              const max =
                                usage?.contextWindowTokens ??
                                contextWindow(
                                  session.model,
                                  session.backend,
                                  session.backend === 'codex' ? codexModels : undefined
                                )
                              if (!max) return null
                              const pct = Math.min(100, Math.round((ctx / max) * 100))
                              if (pct < 80) return null
                              const cls = pct >= 90 ? 'gauge-bad' : 'gauge-warn'
                              return (
                                <span
                                  className={'session-ctx-pill ' + cls}
                                  title={`context ${pct}% full (${ctx.toLocaleString()} tokens)`}
                                >
                                  {pct}%
                                </span>
                              )
                            })()}
                            {isPinned(session.id) && (
                              <span className="session-pin" title="Pinned">
                                <Icon name="pin" size={13} />
                              </span>
                            )}
                            <span className="session-time">{relativeTime(session.updatedAt)}</span>
                          </span>
                          <span className="session-actions">
                            <button
                              className={
                                'ghost-btn session-action' + (isPinned(session.id) ? ' session-pin-on' : '')
                              }
                              title={isPinned(session.id) ? 'Unpin' : 'Pin to top'}
                              onClick={(e) => {
                                e.stopPropagation()
                                togglePin(session.id)
                              }}
                            >
                              <Icon name="pin" size={14} />
                            </button>
                            <button
                              className="ghost-btn session-action"
                              title="Open in split pane"
                              onClick={(e) => {
                                e.stopPropagation()
                                openSession(session.id, { split: true })
                              }}
                            >
                              <Icon name="split-h" size={14} />
                            </button>
                            <button
                              className="ghost-btn session-action"
                              title="Archive session"
                              onClick={(e) => {
                                e.stopPropagation()
                                archiveSession(session.id)
                              }}
                            >
                              <Icon name="archive" size={14} />
                            </button>
                          </span>
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button
        className="archived-open-btn"
        onClick={() => useHang4r.getState().setArchivedOpen(true)}
      >
        <Icon name="archive" size={13} /> Archived sessions
      </button>
      {(cursorAvailable || claudeImportAvailable || codexImportAvailable) && (
        <button
          className="archived-open-btn"
          onClick={() => {
            useHang4r
              .getState()
              .setImportSource(cursorAvailable ? 'cursor' : claudeImportAvailable ? 'claude' : 'codex')
            useHang4r.getState().setCursorImportOpen(true)
          }}
        >
          <Icon name="sparkle" size={13} /> Import a session
        </button>
      )}
      <ClaudeUsagePanel />
      <CodexUsagePanel />
      <CursorUsagePanel />
      <div className="sidebar-resize" onMouseDown={() => (draggingRef.current = true)} />
    </aside>
  )
}

/** Sidebar-bottom usage: Claude 5h window status + total spend across sessions. */
function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

function summarizeBackendStats(
  sessions: SessionMeta[],
  sessionUsage: Record<string, { inputTokens: number; outputTokens: number; contextTokens: number }>,
  backend: BackendId
): {
  inputTokens: number
  outputTokens: number
  totalCost: number
  active: number
  count: number
} {
  const backendSessions = sessions.filter((s) => s.backend === backend)
  return {
    inputTokens: backendSessions.reduce((sum, s) => sum + (sessionUsage[s.id]?.inputTokens ?? 0), 0),
    outputTokens: backendSessions.reduce((sum, s) => sum + (sessionUsage[s.id]?.outputTokens ?? 0), 0),
    totalCost: backendSessions.reduce((sum, s) => sum + s.totalCostUsd, 0),
    active: backendSessions.filter((s) => s.status === 'running' || s.status === 'starting').length,
    count: backendSessions.length
  }
}

function ClaudeUsagePanel(): JSX.Element {
  const sessions = useHang4r((s) => s.sessions)
  return (
    <BackendUsagePanel<ClaudeUsageSnapshot>
      title="Claude usage"
      backend="claude"
      sessions={sessions}
      loadUsage={(force) => window.hang4r.claudeUsage(force)}
      loadingText="Loading usage from Claude…"
      emptyText="Usage unavailable right now — retrying in the background."
      renderExtra={() => null}
    />
  )
}

function CodexUsagePanel(): JSX.Element {
  const sessions = useHang4r((s) => s.sessions)
  return (
    <BackendUsagePanel<CodexUsageSnapshot>
      title="Codex usage"
      backend="codex"
      sessions={sessions}
      loadUsage={(force) => window.hang4r.codexUsage(force)}
      loadingText="Loading usage from Codex…"
      emptyText="Usage unavailable right now — retrying in the background."
      renderExtra={(snapshot) => (
        <div className="usage-stats">
          <span className="usage-stat" title="ChatGPT plan for this Codex account">
            {snapshot.planType ? `plan ${snapshot.planType}` : 'plan unknown'}
          </span>
          <span className="usage-stat" title="Earned reset credits available">
            reset credits {snapshot.resetCredits ?? 0}
          </span>
        </div>
      )}
    />
  )
}

/**
 * Cursor's CLI has no quota/usage-window endpoint (verified against
 * `cursor-agent about` / `status --format json`) — this pane is honest about
 * that: account identity (so a wrong-tier login is obvious at a glance) +
 * hang4r's own token counts, not a fabricated quota gauge.
 */
function CursorUsagePanel(): JSX.Element {
  const sessions = useHang4r((s) => s.sessions)
  const sessionUsage = useHang4r((s) => s.sessionUsage)
  const stats = summarizeBackendStats(sessions, sessionUsage, 'cursor')
  const [snapshot, setSnapshot] = useState<CursorUsageSnapshot | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const collapsedSettingKey = 'usagePanelCollapsed:cursor'

  const load = (force = false): void => {
    if (force) setRefreshing(true)
    void window.hang4r
      .cursorUsage(force)
      .then((next) => {
        setLoadedOnce(true)
        setSnapshot((prev) => (next.email || next.tier || !prev ? next : prev))
        if (next.stale) setTimeout(() => load(), 25_000)
      })
      .finally(() => setRefreshing(false))
  }

  useEffect(() => {
    let alive = true
    void window.hang4r.getSetting(collapsedSettingKey).then((value) => {
      if (!alive) return
      if (value === 'open') setCollapsed(false)
      else if (value === 'closed') setCollapsed(true)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(() => load(), 120_000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stale = snapshot?.stale ?? false
  const tier = snapshot?.tier
  const tierIsFree = !!tier && tier.trim().toLowerCase() === 'free'

  return (
    <div className="sidebar-usage">
      <button
        className="usage-scope"
        onClick={() =>
          setCollapsed((current) => {
            const next = !current
            void window.hang4r.setSetting(collapsedSettingKey, next ? 'closed' : 'open')
            return next
          })
        }
      >
        <span className="usage-caret">{collapsed ? '▸' : '▾'}</span>
        Cursor usage
        <span
          className="usage-refresh"
          title="Refresh"
          onClick={(e) => {
            e.stopPropagation()
            load(true)
          }}
        >
          {refreshing ? '…' : '↻'}
        </span>
      </button>
      {!collapsed && (
        <>
          {!snapshot?.email && !snapshot?.tier && (
            <div className="usage-empty">
              {loadedOnce
                ? 'Account info unavailable right now — retrying in the background.'
                : 'Loading account info from Cursor…'}
            </div>
          )}
          {(snapshot?.email || snapshot?.tier) && stale && (
            <div className="usage-empty" title="Last refresh failed; showing the last good numbers">
              showing cached account info — refreshing…
            </div>
          )}
          {(snapshot?.email || snapshot?.tier) && (
            <div className="usage-account">
              <span className="usage-email" title={snapshot?.email ?? undefined}>
                {snapshot?.email ?? 'unknown account'}
              </span>
              {snapshot?.tier && (
                <span
                  className={'tier-badge' + (tierIsFree ? ' tier-badge-free' : '')}
                  title="Subscription tier reported by cursor-agent about"
                >
                  {snapshot.tier}
                </span>
              )}
            </div>
          )}
          {snapshot?.model && (
            <div className="usage-stats">
              <span className="usage-stat" title="Default model reported by cursor-agent about">
                model {snapshot.model}
              </span>
            </div>
          )}
          <div className="usage-stats">
            <span
              className="usage-stat"
              title="Token totals hang4r has counted for Cursor-backend sessions this app run — not Cursor's own ledger"
            >
              ⤓ {fmtTok(stats.inputTokens)} · ⤒ {fmtTok(stats.outputTokens)} tokens through hang4r
            </span>
          </div>
          <div className="usage-empty">
            cursor-agent doesn't expose quota/usage windows — no plan limits shown here.
          </div>
          <div className="usage-meta">
            <span className="gauge-dot" />
            <span>
              {stats.active > 0 ? `${stats.active} running · ` : ''}
              {stats.count} session{stats.count === 1 ? '' : 's'} · all workspaces
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function BackendUsagePanel<T extends { windows: { label: string; pct: number; resets: string }[]; stale?: boolean; lifetimeTokens?: number }>(
  {
    title,
    backend,
    sessions,
    loadUsage,
    loadingText,
    emptyText,
    renderExtra
  }: {
    title: string
    backend: BackendId
    sessions: SessionMeta[]
    loadUsage: (force?: boolean) => Promise<T>
    loadingText: string
    emptyText: string
    renderExtra: (snapshot: T) => JSX.Element | null
  }
): JSX.Element {
  const sessionUsage = useHang4r((s) => s.sessionUsage)
  const stats = summarizeBackendStats(sessions, sessionUsage, backend)
  const [snapshot, setSnapshot] = useState<T | null>(null)
  const [collapsed, setCollapsed] = useState(backend === 'codex')
  const [refreshing, setRefreshing] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const collapsedSettingKey = `usagePanelCollapsed:${backend}`

  const load = (force = false): void => {
    if (force) setRefreshing(true)
    void loadUsage(force)
      .then((next) => {
        setLoadedOnce(true)
        setSnapshot((prev) => (next.windows.length > 0 || !prev ? next : prev))
        if (next.stale) setTimeout(() => load(), 25_000)
      })
      .finally(() => setRefreshing(false))
  }

  useEffect(() => {
    let alive = true
    void window.hang4r.getSetting(collapsedSettingKey).then((value) => {
      if (!alive) return
      if (value === 'open') setCollapsed(false)
      else if (value === 'closed') setCollapsed(true)
    })
    return () => {
      alive = false
    }
  }, [collapsedSettingKey])

  useEffect(() => {
    load()
    const iv = setInterval(() => load(), 120_000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    if (stats.active === 0) load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.active === 0])

  const windows = snapshot?.windows ?? []
  const stale = snapshot?.stale ?? false

  return (
    <div className="sidebar-usage">
      <button
        className="usage-scope"
        onClick={() =>
          setCollapsed((current) => {
            const next = !current
            void window.hang4r.setSetting(collapsedSettingKey, next ? 'closed' : 'open')
            return next
          })
        }
      >
        <span className="usage-caret">{collapsed ? '▸' : '▾'}</span>
        {title}
        <span
          className="usage-refresh"
          title="Refresh"
          onClick={(e) => {
            e.stopPropagation()
            load(true)
          }}
        >
          {refreshing ? '…' : '↻'}
        </span>
      </button>
      {!collapsed && (
        <>
          {windows.length === 0 && (
            <div className="usage-empty">{loadedOnce ? emptyText : loadingText}</div>
          )}
          {windows.length > 0 && stale && (
            <div className="usage-empty" title="Last refresh failed; showing the last good numbers">
              showing cached usage — refreshing…
            </div>
          )}
          {windows.map((w) => {
            const cls = w.pct >= 90 ? 'gauge-bad' : w.pct >= 70 ? 'gauge-warn' : 'gauge-ok'
            return (
              <UsageGauge
                key={w.label}
                label={w.label}
                sub={`${w.pct}% · resets ${w.resets}`}
                pct={w.pct}
                cls={cls}
              />
            )
          })}
          <div className="usage-stats">
            <span className="usage-stat" title={`tokens in / out — ${backend} sessions this app run`}>
              ⤓ {fmtTok(stats.inputTokens)} · ⤒ {fmtTok(stats.outputTokens)}
            </span>
            <span className="usage-stat" title="API-equivalent cost across this backend">
              ~${stats.totalCost.toFixed(2)}
            </span>
          </div>
          {snapshot && renderExtra(snapshot)}
          <div className="usage-meta">
            <span className="gauge-dot" />
            <span>
              {typeof snapshot?.lifetimeTokens === 'number' && snapshot.lifetimeTokens > 0
                ? `${fmtTok(snapshot.lifetimeTokens)} lifetime · `
                : ''}
              {stats.active > 0 ? `${stats.active} running · ` : ''}
              {stats.count} session{stats.count === 1 ? '' : 's'} · all workspaces
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function UsageGauge({
  label,
  sub,
  pct,
  cls
}: {
  label: string
  sub: string
  pct: number
  cls: string
}): JSX.Element {
  return (
    <div className="usage-gauge" title={`${label} · ${sub}`}>
      <div className="usage-gauge-head">
        <span>{label}</span>
        <span className="usage-gauge-sub">{sub}</span>
      </div>
      <div className="usage-gauge-track">
        <div className={'usage-gauge-fill ' + cls} style={{ width: pct + '%' }} />
      </div>
    </div>
  )
}
