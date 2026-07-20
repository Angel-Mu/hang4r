import { useEffect, useMemo, useState, type JSX } from 'react'
import { useHang4r } from '../state/store'

type InitInfo = ReturnType<typeof useHang4r.getState>['sessionInit'][string]

/**
 * Browses everything the backend loaded for this session — skills, slash
 * commands, MCP servers (with connection status), plugins, and tools — from the
 * init event. Searchable; richer than the read-only Settings list.
 */
type PermRule = { rule: string; kind: 'allow' | 'deny'; source: string }

export function EnvBrowser({ sessionId }: { sessionId: string }): JSX.Element {
  const liveInit = useHang4r((s) => s.sessionInit[sessionId])
  // after an app restart the session is idle (no live init event) — fall back
  // to the persisted snapshot from the last run
  const [cachedInit, setCachedInit] = useState<InitInfo | null>(null)
  const [permRules, setPermRules] = useState<PermRule[]>([])
  useEffect(() => {
    let alive = true
    void window.hang4r.getPermissionRules(sessionId).then((r) => {
      if (alive) setPermRules(r)
    })
    return () => {
      alive = false
    }
  }, [sessionId])
  useEffect(() => {
    if (liveInit) return
    void window.hang4r.getSetting(`sessionInitV1:${sessionId}`).then((v) => {
      if (!v) return
      try {
        const ev = JSON.parse(v)
        setCachedInit({
          model: ev.model,
          version: ev.version,
          tools: ev.tools ?? [],
          skills: ev.skills ?? [],
          slashCommands: ev.slashCommands ?? [],
          mcpServers: ev.mcpServers ?? [],
          plugins: ev.plugins ?? []
        })
      } catch {
        /* ignore corrupt cache */
      }
    })
  }, [liveInit, sessionId])
  const init = liveInit ?? cachedInit
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const match = (s: string): boolean => !q || s.toLowerCase().includes(q)

  const groups = useMemo<{ key: string; items: { name: string; meta?: string }[] }[]>(() => {
    if (!init) return []
    return [
      { key: 'Skills', items: init.skills.filter(match).map((s) => ({ name: s })) },
      { key: 'Commands', items: init.slashCommands.filter(match).map((s) => ({ name: s })) },
      {
        key: 'MCP servers',
        items: init.mcpServers
          .filter((m) => match(m.name) || match(m.status))
          .map((m) => ({ name: m.name, meta: m.status }))
      },
      { key: 'Plugins', items: init.plugins.filter((p) => match(p.name)).map((p) => ({ name: p.name })) },
      { key: 'Tools', items: init.tools.filter(match).map((s) => ({ name: s })) },
      {
        // the CLI's own settings-file rules — these never prompt (allow) /
        // always refuse (deny), so you know what won't ask before it runs
        key: 'Whitelisted permissions',
        items: permRules
          .filter((r) => r.kind === 'allow' && (match(r.rule) || match(r.source)))
          .map((r) => ({ name: r.rule, meta: r.source }))
      },
      {
        key: 'Denied permissions',
        items: permRules
          .filter((r) => r.kind === 'deny' && (match(r.rule) || match(r.source)))
          .map((r) => ({ name: r.rule, meta: r.source }))
      }
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init, q, permRules])

  if (!init) {
    return <div className="diff-empty">Environment loads once the session has started.</div>
  }

  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const stale = !liveInit

  return (
    <div className="env-view">
      {stale && (
        <div className="env-stale-note">from the last run — refreshes when the agent starts</div>
      )}
      <div className="env-search">
        <input
          className="files-search-input"
          placeholder="Search skills, commands, MCP, tools…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="env-scroll">
        {total === 0 && <div className="search-empty">Nothing matches “{query}”.</div>}
        {groups.map((g) =>
          g.items.length === 0 ? null : (
            <div key={g.key} className="env-group">
              <div className="env-group-head">
                {g.key} <span className="env-group-count">{g.items.length}</span>
              </div>
              {g.items.map((it) => (
                <div key={it.name} className="env-item">
                  <span className="env-item-name">{it.name}</span>
                  {it.meta && (
                    <span
                      className={
                        'env-item-meta' +
                        (it.meta === 'connected' || it.meta === 'ready' ? ' env-ok' : '')
                      }
                    >
                      {it.meta}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
