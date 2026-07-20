import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useHang4r } from '../state/store'

interface ExternalSession {
  id: string
  name: string
  customName?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  cwd?: string
  lastMessage?: string
}

/** server page size — matches the backend default; keep newest-first order */
const PAGE = 100

function relTime(ts: number): string {
  if (!ts) return ''
  const d = Math.floor((Date.now() - ts) / 86400000)
  if (d <= 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d}d ago`
  return `${Math.floor(d / 30)}mo ago`
}

const folderOf = (p?: string): string => (p ? (p.split('/').filter(Boolean).pop() ?? '') : '')
const trimRoot = (p: string): string => p.replace(/\/+$/, '')

/**
 * Import a past session from Cursor, Claude Code, or Codex and continue it in
 * hang4r. Same-engine imports resume the original backend conversation; Cursor
 * sessions seed a fresh Claude session with the transcript.
 */
export function CursorImport(): JSX.Element | null {
  const open = useHang4r((s) => s.cursorImportOpen)
  const close = useHang4r((s) => s.setCursorImportOpen)
  const source = useHang4r((s) => s.importSource)
  const setSource = useHang4r((s) => s.setImportSource)
  const projects = useHang4r((s) => s.projects)
  const importSession = useHang4r((s) => s.importExternalSession)
  const [items, setItems] = useState<ExternalSession[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [query, setQuery] = useState('')
  /** '' = all my workspaces · '<projectId>' = one · 'all' = everywhere */
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const label =
    source === 'cursor'
      ? 'Cursor'
      : source === 'claude'
        ? 'Claude Code'
        : source === 'cursorAgent'
          ? 'Cursor CLI'
          : 'Codex'
  const sameEngine = source === 'claude' || source === 'codex' || source === 'cursorAgent'

  // Claude/Codex record cwd per session, so filter to the chosen workspace root(s).
  // Cursor doesn't record workspace association, so it lists everything.
  const roots = useMemo(
    () =>
      scope === 'all'
        ? undefined
        : scope
          ? projects.filter((p) => p.id === scope).map((p) => p.path)
          : projects.map((p) => p.path),
    [scope, projects]
  )
  // zero workspaces: nothing is importable ANYWHERE, and an empty roots list
  // means "no filter" to the backend — it would flood the full unfiltered
  // history. Short-circuit so the "add a workspace first" empty state shows.
  const noTargets = sameEngine && projects.length === 0

  // guards stale async: every reset bumps the token; late responses are dropped
  const reqRef = useRef(0)
  // latest loaded count + loadMore, read from the IntersectionObserver callback
  const countRef = useRef(0)
  countRef.current = items.length

  // (re)load the first page whenever the source / scope / workspace set changes
  useEffect(() => {
    if (!open) return
    const token = ++reqRef.current
    setLoading(true)
    setItems([])
    setHasMore(false)
    if (source === 'cursor') {
      void window.hang4r.listCursorSessions().then((s) => {
        if (reqRef.current !== token) return
        setItems(s)
        setHasMore(false)
        setLoading(false)
      })
    } else if (noTargets) {
      setLoading(false) // items stay [] → the "add a workspace first" empty state
    } else if (source === 'claude') {
      void window.hang4r.listClaudeSessions(roots, 0, PAGE).then((r) => {
        if (reqRef.current !== token) return
        setItems(r.sessions)
        setHasMore(r.hasMore)
        setLoading(false)
      })
    } else if (source === 'cursorAgent') {
      void window.hang4r.listCursorAgentSessions(roots, 0, PAGE).then((r) => {
        if (reqRef.current !== token) return
        setItems(r.sessions)
        setHasMore(r.hasMore)
        setLoading(false)
      })
    } else {
      void window.hang4r.listCodexSessions(roots, 0, PAGE).then((r) => {
        if (reqRef.current !== token) return
        setItems(r.sessions)
        setHasMore(r.hasMore)
        setLoading(false)
      })
    }
  }, [open, source, roots, noTargets, sameEngine])

  // pull the next page for same-engine histories when the list is near the bottom
  const loadMore = useCallback(() => {
    if (!sameEngine || loadingMore || !hasMore) return
    const token = reqRef.current
    setLoadingMore(true)
    const req =
      source === 'claude'
        ? window.hang4r.listClaudeSessions(roots, countRef.current, PAGE)
        : source === 'cursorAgent'
          ? window.hang4r.listCursorAgentSessions(roots, countRef.current, PAGE)
          : window.hang4r.listCodexSessions(roots, countRef.current, PAGE)
    void req.then((r) => {
      if (reqRef.current !== token) {
        setLoadingMore(false)
        return
      }
      setItems((prev) => [...prev, ...r.sessions])
      setHasMore(r.hasMore)
      setLoadingMore(false)
    })
  }, [source, sameEngine, roots, loadingMore, hasMore])
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore

  // observe a sentinel at the end of the list; fire loadMore as it approaches
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !open || !hasMore) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current()
      },
      { root: listRef.current, rootMargin: '240px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [open, hasMore, loading])

  // Esc closes the dialog (matches every other overlay)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // which added workspace a session belongs to (by cwd), for the import target
  const matchProject = useMemo(() => {
    const roots = projects.map((p) => ({ id: p.id, root: trimRoot(p.path) }))
    return (cwd?: string): string | undefined => {
      if (!cwd) return undefined
      const c = trimRoot(cwd)
      return roots.find((r) => c === r.root || c.startsWith(r.root + '/'))?.id
    }
  }, [projects])

  if (!open) return null

  const q = query.trim().toLowerCase()
  const filtered = items.filter(
    (s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      (s.customName ?? '').toLowerCase().includes(q) ||
      (s.lastMessage ?? '').toLowerCase().includes(q) ||
      (s.cwd ?? '').toLowerCase().includes(q)
  )

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="dialog archived-dialog import-dialog">
        <div className="dialog-title archived-title">
          Import a session
          <button className="ghost-btn" onClick={() => close(false)}>
            ✕
          </button>
        </div>
        <div className="import-source-tabs">
          <button
            className={'import-source-tab' + (source === 'cursor' ? ' on' : '')}
            onClick={() => setSource('cursor')}
          >
            Cursor
          </button>
          <button
            className={'import-source-tab' + (source === 'claude' ? ' on' : '')}
            onClick={() => setSource('claude')}
          >
            Claude Code
          </button>
          <button
            className={'import-source-tab' + (source === 'codex' ? ' on' : '')}
            onClick={() => setSource('codex')}
          >
            Codex
          </button>
          <button
            className={'import-source-tab' + (source === 'cursorAgent' ? ' on' : '')}
            onClick={() => setSource('cursorAgent')}
          >
            Cursor CLI
          </button>
        </div>
        <p className="settings-note">
          Read from {label}&rsquo;s local history. &ldquo;Continue in hang4r&rdquo; resumes same-engine
          sessions when possible; Cursor imports seed a new Claude session.
          {source === 'cursor' && (
            <>
              {' '}
              macOS may ask to let hang4r &ldquo;access data from other apps&rdquo; — that&rsquo;s
              Cursor&rsquo;s local session database, read-only, only for this list.
            </>
          )}
        </p>
        <div className="cursor-import-controls">
          <input
            className="field"
            autoFocus
            placeholder="Search name or last message…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {sameEngine && (
            <select className="field" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All my workspaces</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="all">Everywhere (all history)</option>
            </select>
          )}
        </div>
        <div className="archived-list import-list" ref={listRef}>
          {loading && <div className="palette-empty">Reading {label} history…</div>}
          {!loading && items.length === 0 && (
            <div className="palette-empty">
              {sameEngine && projects.length === 0
                ? `Add a workspace first, then your ${label} sessions here will show up.`
                : sameEngine && scope !== 'all'
                  ? `No ${label} sessions found in your workspaces. Try “Everywhere”.`
                  : `No ${label} history found on this machine.`}
            </div>
          )}
          {filtered.map((s) => {
            const target = matchProject(s.cwd) ?? (scope && scope !== 'all' ? scope : projects[0]?.id)
            // a custom /rename name is the headline; the first prompt (or, absent
            // that, the last message) becomes the dim preview underneath it.
            const display = s.customName || s.name
            const preview = s.customName ? s.name || s.lastMessage : s.lastMessage
            return (
              <div key={s.id} className="import-row">
                <div className="import-row-main">
                  <div className="import-row-name" title={display}>
                    {display}
                  </div>
                  {preview && (
                    <div className="import-row-last" title={preview}>
                      {preview}
                    </div>
                  )}
                  <div className="import-row-meta">
                    {s.cwd && (
                      <span className="import-folder" title={s.cwd}>
                        ⬡ {folderOf(s.cwd)}
                      </span>
                    )}
                    <span>
                      {s.messageCount} msg · {relTime(s.updatedAt)}
                    </span>
                  </div>
                </div>
                <button
                  className="ghost-btn archived-restore"
                  disabled={!target || busy === s.id}
                  title={target ? undefined : 'Add a workspace to import into'}
                  onClick={() => {
                    if (!target) return
                    setBusy(s.id)
                    void importSession(source, s.id, display, target, s.cwd).finally(() =>
                      setBusy(null)
                    )
                  }}
                >
                  {busy === s.id
                    ? sameEngine
                      ? 'Resuming…'
                      : 'Importing…'
                    : 'Continue in hang4r'}
                </button>
              </div>
            )
          })}
          {!loading && hasMore && (
            <div ref={sentinelRef} className="import-loading-more">
              {loadingMore ? 'Loading more…' : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
