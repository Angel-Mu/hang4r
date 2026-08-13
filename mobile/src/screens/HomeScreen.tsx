import { useEffect, type JSX } from 'react'
import type { SessionMeta } from '@shared/protocol'
import { useApp } from '../state/store'

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

export function HomeScreen(): JSX.Element {
  const conn = useApp((s) => s.conn)
  const projects = useApp((s) => s.projects)
  const sessions = useApp((s) => s.sessions)
  const attention = useApp((s) => s.attention)
  const refresh = useApp((s) => s.refresh)
  const openSession = useApp((s) => s.openSession)
  const setScreen = useApp((s) => s.setScreen)
  const error = useApp((s) => s.error)

  useEffect(() => {
    if (conn === 'online') void refresh()
  }, [conn, refresh])

  return (
    <div className="screen home-screen">
      <header className="topbar">
        <span className="topbar-title">hang4r</span>
        <ConnDot />
        <button className="btn btn-ghost topbar-action" onClick={() => setScreen('usage')}>
          ◔
        </button>
        <button className="btn btn-ghost topbar-action" onClick={() => setScreen('settings')}>
          ⚙
        </button>
        <button className="btn btn-primary topbar-new" onClick={() => setScreen('new')}>
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
        {projects.map((p) => {
          const own = sessions.filter((s) => s.projectId === p.id && s.status !== 'archived')
          if (!own.length) return null
          return (
            <section key={p.id} className="project-group">
              <h2 className="project-name">{p.name}</h2>
              {own.map((s) => (
                <button key={s.id} className="session-row" onClick={() => void openSession(s.id)}>
                  <span className={`status-dot status-${s.status}`} />
                  <span className="session-title">{s.title}</span>
                  {attention[s.id] && <span className="attention-dot">●</span>}
                  <span className={`backend-chip backend-${s.backend}`}>{s.backend}</span>
                  <span className="session-status">{STATUS_LABEL[s.status]}</span>
                </button>
              ))}
            </section>
          )
        })}
        {conn === 'online' && sessions.filter((s) => s.status !== 'archived').length === 0 && (
          <p className="empty-note">No live sessions. Start one on your computer — it shows up here instantly.</p>
        )}
      </main>
      <footer className="home-footer">
        <button className="btn btn-ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </footer>
    </div>
  )
}
