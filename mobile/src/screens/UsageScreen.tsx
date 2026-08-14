import { useEffect, useState, type JSX } from 'react'
import type {
  ClaudeUsageSnapshot,
  CodexUsageSnapshot,
  CursorUsageSnapshot,
  UsageWindow
} from '@shared/protocol'
import { Icon } from '@shared/icons'
import { bridge, useApp } from '../state/store'
import { useNav } from '../components/PushScreen'

function Windows({ windows }: { windows: UsageWindow[] }): JSX.Element {
  return (
    <>
      {windows.map((w) => (
        <div key={w.label} className="usage-window">
          <div className="usage-window-head">
            <span>{w.label}</span>
            <span>
              {w.pct}% · resets {w.resets}
            </span>
          </div>
          <div className="usage-bar">
            <div
              className={'usage-fill' + (w.pct >= 90 ? ' usage-hot' : '')}
              style={{ width: `${Math.min(100, w.pct)}%` }}
            />
          </div>
        </div>
      ))}
    </>
  )
}

export function UsageScreen(): JSX.Element {
  const nav = useNav()
  const [claude, setClaude] = useState<ClaudeUsageSnapshot | null>(null)
  const [codex, setCodex] = useState<CodexUsageSnapshot | null>(null)
  const [cursor, setCursor] = useState<CursorUsageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  const load = (): void => {
    setLoading(true)
    void Promise.allSettled([
      bridge().call<ClaudeUsageSnapshot>('claudeUsage'),
      bridge().call<CodexUsageSnapshot>('codexUsage'),
      bridge().call<CursorUsageSnapshot>('cursorUsage')
    ]).then(([a, b, c]) => {
      if (a.status === 'fulfilled') setClaude(a.value)
      if (b.status === 'fulfilled') setCodex(b.value)
      if (c.status === 'fulfilled') setCursor(c.value)
      setLoading(false)
    })
  }

  useEffect(load, [])

  return (
    <div className="screen">
      <header className="topbar">
        <button className="btn btn-ghost" onClick={nav.back}>
          ‹ Back
        </button>
        <span className="topbar-title">Usage</span>
        <button className="btn btn-ghost topbar-action" aria-label="Refresh" onClick={load}>
          <Icon name="refresh" size={17} />
        </button>
      </header>
      <main className="form-screen">
        {loading && !claude && !codex && !cursor && <p className="empty-note">Asking your CLIs…</p>}
        {claude && (
          <section className="usage-card">
            <h2 className="usage-title">Claude{claude.stale ? ' · stale' : ''}</h2>
            <Windows windows={claude.windows} />
          </section>
        )}
        {codex && (
          <section className="usage-card">
            <h2 className="usage-title">
              Codex{codex.planType ? ` · ${codex.planType}` : ''}
              {codex.stale ? ' · stale' : ''}
            </h2>
            <Windows windows={codex.windows} />
          </section>
        )}
        {cursor && (
          <section className="usage-card">
            <h2 className="usage-title">Cursor{cursor.stale ? ' · stale' : ''}</h2>
            <p className="usage-line">
              {cursor.tier ?? 'unknown tier'}
              {cursor.model ? ` · ${cursor.model}` : ''}
            </p>
            {cursor.email && <p className="usage-line usage-dim">{cursor.email}</p>}
          </section>
        )}
        {!loading && !claude && !codex && !cursor && (
          <p className="empty-note">No usage data — are the CLIs logged in on your computer?</p>
        )}
      </main>
    </div>
  )
}
