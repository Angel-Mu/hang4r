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
  /** run_in_background commands still writing — the only kind with a file to
   *  probe, so the only kind that can be RETIRED without another turn */
  commands: number
  /** tools that return now and continue later (Monitor, Workflow). They leave
   *  nothing to probe, so the claim is scoped to the last turn rather than
   *  standing forever. */
  deferred: string[]
  /** runs whose tool call never returned — not running, never will be */
  stalled: number
  /** toolUseIds of the background agents, so a click can land on one */
  agentIds: string[]
  /** subagents that failed in the LAST turn — the conversation may still be
   *  waiting on a report that will never arrive */
  failed: number
  failedIds: string[]
}

/** One clickable piece of the footer, and the panel it belongs to. `panel` is
 *  null for work with no panel of its own — a Monitor is a tool row in the
 *  conversation, not an entry in Subagents or Tasks. */
export interface PendingPart {
  text: string
  panel: 'subagents' | 'tasks' | null
  /** for 'subagents': the run to expand and scroll to */
  toolUseId?: string
}

/**
 * Output files of the background commands the TRANSCRIPT still calls running.
 * The transcript only learns a command finished if a completion note happens to
 * name it, so it can say "running" long after the thing exited — Angel watched a
 * finished command keep the footer on "waiting" until he sent another message.
 * The truth is whether anything still holds the file open; `verifyFinished`
 * feeds that answer back in.
 */
export function pendingTaskPaths(items: TranscriptItem[]): string[] {
  return collectTasks(items)
    .filter((t) => t.kind !== 'workflow' && t.status === 'running' && t.outputPath)
    .map((t) => t.outputPath as string)
}

export function pendingWork(
  items: TranscriptItem[],
  turnLive: boolean,
  /** output paths an lsof probe has since proved finished */
  finishedPaths: ReadonlySet<string> = new Set(),
  /** async agents the live CLI process still owns — the rest died with an
   *  earlier one and must not be reported as still running */
  liveAgentIds?: ReadonlySet<string>
): PendingWork {
  const { background, stalled, deferred, backgroundIds, failed, failedIds } = summarizeRuns(
    items,
    turnLive,
    liveAgentIds
  )
  // Only claim what can be RETIRED. A command with no output file can never be
  // proved finished, so counting it would strand the footer on "waiting"
  // forever — under-claiming beats lying.
  const commands = collectTasks(items).filter(
    (t) =>
      t.kind !== 'workflow' &&
      t.status === 'running' &&
      !!t.outputPath &&
      !finishedPaths.has(t.outputPath)
  ).length
  return {
    agents: background,
    commands,
    deferred,
    stalled,
    agentIds: backgroundIds,
    failed,
    failedIds
  }
}

/** anything the user would be wrong to read as finished, plus a failure the
 *  conversation has not accounted for */
export function hasPendingWork(p: PendingWork): boolean {
  return p.agents > 0 || p.commands > 0 || p.deferred.length > 0 || p.failed > 0
}

/**
 * Work that can be PROVED still running — agents owned by the live process, and
 * commands with a file to probe.
 *
 * Deferred tools (Monitor, Workflow) are deliberately excluded: nothing ever
 * retires them, so a session that armed one three days ago would keep a
 * persistent marker lit forever. The turn footer still names them, because there
 * it describes that turn in place rather than claiming something is running
 * right now.
 */
export function hasVerifiableWork(p: PendingWork): boolean {
  return p.agents > 0 || p.commands > 0
}

/** the footer's pieces, each pointing at where that work can be watched */
export function pendingParts(p: PendingWork): PendingPart[] {
  const parts: PendingPart[] = []
  if (p.agents > 0) {
    parts.push({
      text: `${p.agents} agent${p.agents === 1 ? '' : 's'}`,
      panel: 'subagents',
      toolUseId: p.agentIds[0]
    })
  }
  if (p.commands > 0) {
    parts.push({
      text: `${p.commands} background command${p.commands === 1 ? '' : 's'}`,
      panel: 'tasks'
    })
  }
  // Workflow has a row in Tasks; Monitor has no panel of its own
  parts.push(
    ...p.deferred.map((d) => ({ text: d, panel: d === 'Workflow' ? ('tasks' as const) : null }))
  )
  if (p.failed > 0) {
    parts.push({
      text: `${p.failed} agent${p.failed === 1 ? '' : 's'} failed`,
      panel: 'subagents',
      toolUseId: p.failedIds[0]
    })
  }
  return parts
}
