import { type JSX } from 'react'
import type { BackendId } from '../../../shared/protocol'
import { useHang4r } from '../state/store'
import { Icon, type IconName } from './Icon'

/** Status → gauge color. */
const STATUS_CLASS: Record<string, string> = {
  allowed: 'gauge-ok',
  allowed_warning: 'gauge-warn',
  warning: 'gauge-warn',
  rejected: 'gauge-bad',
  exceeded: 'gauge-bad'
}

const LABELS: Record<string, string> = {
  five_hour: '5h',
  weekly: 'week',
  daily: 'day'
}

// Same per-backend identity glyph + tint used in the sidebar (Icon.tsx /
// .backend-claude etc in main.css) — kept in sync so "which backends are
// running" reads as the same visual language everywhere.
const BACKEND_ORDER: BackendId[] = ['claude', 'codex', 'cursor']
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

/**
 * Top-bar usage gauges: Claude rate-limit windows (status + reset countdown),
 * aggregate spend across sessions, and live token counts. Cursor's usage
 * gauges, backed by the CLI's own rate_limit_event and result-cost stream.
 */
export function UsageBar(): JSX.Element {
  const sessions = useHang4r((s) => s.sessions)
  const usage = useHang4r((s) => s.usage)
  const rateLimits = useHang4r((s) => s.rateLimits)

  const totalCost = sessions.reduce((sum, s) => sum + s.totalCostUsd, 0)
  const rateEntries = Object.entries(rateLimits)
  // How many sessions are running/starting per backend — never collapse this
  // to one name or one number: with Claude, Codex and Cursor all active at
  // once, a single label can only ever be honest about one of them.
  const runningByBackend = BACKEND_ORDER.map((backend) => ({
    backend,
    count: sessions.filter((s) => s.backend === backend && (s.status === 'running' || s.status === 'starting'))
      .length
  })).filter((b) => b.count > 0)

  return (
    <div className="usage-bar" data-testid="usage-bar">
      {rateEntries.map(([type, rl]) => (
        <div key={type} className={'gauge ' + (STATUS_CLASS[rl.status] ?? 'gauge-ok')} title={`${type}: ${rl.status}`}>
          <span className="gauge-label">{LABELS[type] ?? type}</span>
          <span className="gauge-dot" />
          <span className="gauge-value">{resetCountdown(rl.resetsAt)}</span>
        </div>
      ))}
      <div
        className="gauge gauge-neutral"
        title="API-equivalent cost across sessions — informational. On a Claude subscription (Pro/Max) this is covered by your plan, not billed on top."
      >
        <span className="gauge-label">cost</span>
        <span className="gauge-value">${totalCost.toFixed(3)}</span>
      </div>
      <div className="gauge gauge-neutral" title="Tokens this app session (in / out)">
        <span className="gauge-label">tokens</span>
        <span className="gauge-value">
          {fmt(usage.inputTokens)}↓ {fmt(usage.outputTokens)}↑
        </span>
      </div>
      {runningByBackend.length > 0 && (
        <div
          className="gauge gauge-active"
          data-testid="running-gauge"
          title={runningByBackend.map((b) => `${b.count} ${BACKEND_LABEL[b.backend]} running`).join(' · ')}
        >
          <span className="gauge-dot gauge-dot-pulse" />
          {runningByBackend.map((b) => (
            <span key={b.backend} className={`gauge-backend backend-${b.backend}`} data-backend={b.backend}>
              <Icon name={BACKEND_ICON[b.backend]} size={12} />
              {b.count}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function resetCountdown(resetsAt: number): string {
  // resetsAt is a unix seconds timestamp; show coarse time remaining.
  const secs = resetsAt - Math.floor(Date.now() / 1000)
  if (secs <= 0) return 'now'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function fmt(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}
