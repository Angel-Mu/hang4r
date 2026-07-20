import type { JSX } from 'react'
import { useHang4r } from '../state/store'

/**
 * Timeline of Claude Code lifecycle hooks (PreToolUse / PostToolUse / Stop / …)
 * fired during the session. Each row is one hook run with its triggering event
 * and outcome — visibility into the automation wired around the agent.
 */
export function HooksTimeline({ sessionId }: { sessionId: string }): JSX.Element {
  const hooks = useHang4r((s) => s.transcripts[sessionId]?.hooks) ?? EMPTY

  if (hooks.length === 0) {
    return (
      <div className="diff-empty">
        No hooks have fired yet. Configured Claude Code hooks (PreToolUse, PostToolUse, Stop, …)
        appear here as they run.
      </div>
    )
  }

  return (
    <div className="hooks-view">
      <div className="hooks-header">Hooks ({hooks.length})</div>
      <ol className="hooks-list">
        {hooks.map((h, i) => (
          <li key={i} className={'hook-row hook-' + h.status}>
            <span className="hook-dot" />
            <span className="hook-event">{h.hookEvent}</span>
            <span className="hook-name">{h.hookName}</span>
            <span className={'hook-status hook-status-' + h.status}>
              {h.status === 'done' ? (h.outcome ?? 'done') : 'running…'}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

const EMPTY: never[] = []
