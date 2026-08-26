import type { TranscriptItem } from './state/store'
import { summarizeRuns } from './components/SubagentInspector'
import { collectTasks } from './components/BackgroundTasks'

/**
 * Everything a finished turn can leave running, in ONE place.
 *
 * "done" is the truth about the TURN and says nothing about what it started, so
 * every surface that reports a turn — the footer that literally prints "done",
 * and the strip above the composer — asks this instead of each recognising
 * background work for itself. Angel found the gap three times in a row (async
 * agents, then Workflow, then Monitor) precisely because they were separate.
 */
export interface PendingWork {
  /** async agents that outlive the turn */
  agents: number
  /** run_in_background commands still writing */
  commands: number
  /** Workflows still going, by their own name */
  workflows: string[]
  /** tools that return now and continue later, by name (Monitor) */
  deferred: string[]
  /** runs whose tool call never returned — not running, never will be */
  stalled: number
}

export function pendingWork(items: TranscriptItem[], turnLive: boolean): PendingWork {
  const { background, stalled, deferred } = summarizeRuns(items, turnLive)
  const live = collectTasks(items).filter((t) => t.status === 'running')
  return {
    agents: background,
    commands: live.filter((t) => t.kind !== 'workflow').length,
    workflows: [...new Set(live.filter((t) => t.kind === 'workflow').map((t) => t.command))],
    deferred,
    stalled
  }
}

/** anything the user would be wrong to read as finished */
export function hasPendingWork(p: PendingWork): boolean {
  return p.agents > 0 || p.commands > 0 || p.workflows.length > 0 || p.deferred.length > 0
}

/** short phrase for the turn footer, where the word "done" used to be */
export function pendingLabel(p: PendingWork): string {
  const parts: string[] = []
  if (p.agents > 0) parts.push(`${p.agents} agent${p.agents === 1 ? '' : 's'}`)
  if (p.commands > 0) parts.push(`${p.commands} background command${p.commands === 1 ? '' : 's'}`)
  parts.push(...p.workflows.map((w) => `workflow ${w}`))
  parts.push(...p.deferred)
  return parts.join(' · ')
}
