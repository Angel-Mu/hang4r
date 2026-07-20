import { useEffect, useState, type JSX } from 'react'
import type { SessionMeta } from '../../../shared/protocol'
import { useHang4r } from '../state/store'

function relTime(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 86400000)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d}d ago`
  return `${Math.floor(d / 30)}mo ago`
}

/** Archived-sessions history browser: search + restore past sessions. */
export function ArchivedSessions(): JSX.Element | null {
  const open = useHang4r((s) => s.archivedOpen)
  const close = useHang4r((s) => s.setArchivedOpen)
  const unarchive = useHang4r((s) => s.unarchiveSession)
  const projects = useHang4r((s) => s.projects)
  const [items, setItems] = useState<SessionMeta[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (open) {
      setQuery('')
      void window.hang4r.listArchivedSessions().then(setItems)
    }
  }, [open])

  // Esc closes the dialog (matches every other overlay)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  const projName = (id: string): string => projects.find((p) => p.id === id)?.name ?? ''
  const filtered = items.filter(
    (s) => !query.trim() || s.title.toLowerCase().includes(query.trim().toLowerCase())
  )

  const restore = async (id: string): Promise<void> => {
    await unarchive(id)
    setItems((cur) => cur.filter((s) => s.id !== id))
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="dialog archived-dialog">
        <div className="dialog-title archived-title">
          Archived sessions
          <button className="ghost-btn" onClick={() => close(false)}>
            ✕
          </button>
        </div>
        <input
          className="field"
          autoFocus
          placeholder="Search archived sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="archived-list">
          {filtered.length === 0 && <div className="palette-empty">No archived sessions</div>}
          {filtered.map((s) => (
            <div key={s.id} className="archived-row">
              <span className="archived-name" title={s.title}>
                {s.title}
              </span>
              <span className="archived-meta">
                {projName(s.projectId)} · {s.backend} · {relTime(s.updatedAt)}
              </span>
              <button className="ghost-btn archived-restore" onClick={() => void restore(s.id)}>
                Restore
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
