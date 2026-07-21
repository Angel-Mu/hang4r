import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { mdComponents } from './MarkdownBlocks'
import { useHang4r, type TranscriptItem } from '../state/store'
import { onSeedSessionUi, onForgetSession, persistSessionUi } from '../sessionUiMemos'

type BlockItem = Extract<TranscriptItem, { type: 'block' }>
type PermissionItem = Extract<TranscriptItem, { type: 'permission' }>

type RunStatus = 'running' | 'waiting' | 'background' | 'done' | 'error'

interface SubagentRun {
  toolUseId: string
  label: string
  subagentType: string
  status: RunStatus
  /** cleaned final text of a completed run (never raw harness JSON) */
  resultText?: string
  /** harness id of an async (background) launch — matches completion notes */
  agentId?: string
  blocks: BlockItem[]
  toolCount: number
  pendingPermissions: PermissionItem[]
}

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'running',
  waiting: 'waiting for approval',
  background: 'running in background',
  done: 'done',
  error: 'failed'
}

/**
 * Subagents as followable THREADS (Cursor 3.2 multitask / VS Code subagent
 * tree style): each Task/Agent run is a live conversation card — status that
 * tells the truth (waiting-for-approval beats "done"), inline approvals,
 * expandable tool rows, a scrollable auto-following body, and a cleaned final
 * result instead of raw harness metadata.
 */
export function SubagentInspector({ sessionId }: { sessionId: string }): JSX.Element {
  const transcript = useHang4r((s) => s.transcripts[sessionId])
  const running = useHang4r(
    (s) => s.sessions.find((x) => x.id === sessionId)?.status === 'running'
  )
  const runs = useMemo(() => collectRuns(transcript?.items ?? []), [transcript])

  if (runs.length === 0) {
    return (
      <div className="diff-empty">
        No subagents yet. When the agent delegates work to a subagent (via the
        Agent/Task tool), each run appears here as a followable thread. For
        commands the agent runs in the background, see the Tasks tab.
      </div>
    )
  }

  return (
    <div className="subagents-view">
      <div className="subagents-header">
        Subagents ({runs.length})
        {running && (
          <button
            className="ghost-btn stop-turn-btn"
            title="Stops the whole turn — the CLI protocol has no per-subagent kill, so this stops ALL running subagents (they resume context on the next message)"
            onClick={() => void useHang4r.getState().interrupt(sessionId)}
          >
            ■ Stop turn
          </button>
        )}
      </div>
      {runs.map((run) => (
        <SubagentThread key={run.toolUseId} run={run} sessionId={sessionId} />
      ))}
    </div>
  )
}

/**
 * Collapse state must SURVIVE tab switches (the panel unmounts when you leave
 * the Subagents tab) — kept module-scope per `${sessionId}:${toolUseId}`. It
 * also persists to disk (sessionUi) so a manual collapse is remembered across
 * an app RESTART, not just a remount (Angel: everything re-expanded on restart).
 */
const collapsedRuns = new Map<string, boolean>()

/** on startup, seed the collapsed set for a session from its persisted snapshot */
onSeedSessionUi((sessionId, snap) => {
  for (const toolUseId of snap.collapsedSubagents ?? []) {
    collapsedRuns.set(`${sessionId}:${toolUseId}`, true)
  }
})
/** archiving a session clears its remembered collapse state */
onForgetSession((sessionId) => {
  const prefix = `${sessionId}:`
  for (const k of [...collapsedRuns.keys()]) if (k.startsWith(prefix)) collapsedRuns.delete(k)
})
/** write the session's currently-collapsed toolUseIds to disk (best-effort) */
function persistCollapsed(sessionId: string): void {
  const prefix = `${sessionId}:`
  const collapsed: string[] = []
  for (const [k, v] of collapsedRuns) if (v && k.startsWith(prefix)) collapsed.push(k.slice(prefix.length))
  void persistSessionUi(sessionId, { collapsedSubagents: collapsed })
}

function SubagentThread({ run, sessionId }: { run: SubagentRun; sessionId: string }): JSX.Element {
  const collapseKey = `${sessionId}:${run.toolUseId}`
  const [open, setOpenState] = useState(!(collapsedRuns.get(collapseKey) ?? false))
  const setOpen = (o: boolean): void => {
    collapsedRuns.set(collapseKey, !o)
    setOpenState(o)
    persistCollapsed(sessionId)
  }
  const bodyRef = useRef<HTMLDivElement>(null)
  const live = run.status === 'running' || run.status === 'waiting' || run.status === 'background'

  // follow the tail while the subagent works (like the main chat)
  useEffect(() => {
    const el = bodyRef.current
    if (el && live) el.scrollTop = el.scrollHeight
  }, [run.blocks.length, run.pendingPermissions.length, live])

  return (
    <div className={'subagent-run subagent-' + run.status}>
      <button className="subagent-run-header" onClick={() => setOpen(!open)}>
        <span className="subagent-caret">{open ? '▾' : '▸'}</span>
        <span className={'subagent-dot subagent-dot-' + run.status} />
        <span className="subagent-type">{run.subagentType}</span>
        <span className="subagent-label" title={run.label}>
          {run.label}
        </span>
        <span className="subagent-meta">
          {run.toolCount > 0 ? `${run.toolCount} tools · ` : ''}
        </span>
        <span className={'subagent-status subagent-status-' + run.status}>
          {STATUS_LABEL[run.status]}
        </span>
      </button>
      {open && (
        <div className="subagent-run-body" ref={bodyRef}>
          {run.blocks.length === 0 && run.status !== 'done' && (
            <div className="subagent-empty">…starting up</div>
          )}
          {run.blocks.map((m) =>
            m.blockType === 'tool_use' ? (
              <SubagentToolRow key={m.key} item={m} />
            ) : m.blockType === 'thinking' ? (
              m.text.trim() && (
                <div key={m.key} className="subagent-thinking">
                  {m.text}
                </div>
              )
            ) : (
              m.text.trim() && (
                <div key={m.key} className="subagent-text">
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents(sessionId)}>{m.text}</Markdown>
                </div>
              )
            )
          )}
          {run.pendingPermissions.map((p) => (
            <SubagentApproval key={p.requestId} item={p} sessionId={sessionId} />
          ))}
          {run.resultText && (
            <div className="subagent-result">
              <div className="subagent-result-label">result</div>
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents(sessionId)}>{run.resultText}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** expandable tool row — full command/input + result on click, like the chat */
function SubagentToolRow({ item }: { item: BlockItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  const pending = item.toolResult === undefined
  return (
    <div className="subagent-tool-row">
      <button className="subagent-tool" onClick={() => setOpen((o) => !o)}>
        <span className={'subagent-tool-dot' + (pending ? ' pending' : item.toolResultError ? ' err' : '')} />
        <span className="tool-name">{item.toolName}</span>
        <span className="tool-summary">{summarize(item.toolInput)}</span>
      </button>
      {open && (
        <div className="subagent-tool-detail">
          <pre>{pretty(item.toolInput)}</pre>
          {item.toolResult !== undefined && (
            <pre className={item.toolResultError ? 'tool-detail-err' : ''}>
              {pretty(item.toolResult).slice(0, 4000)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/** inline approval — the run is BLOCKED on this; answer it right here */
function SubagentApproval({
  item,
  sessionId
}: {
  item: PermissionItem
  sessionId: string
}): JSX.Element {
  const respondPermission = useHang4r((s) => s.respondPermission)
  return (
    <div className="subagent-approval">
      <span className="subagent-approval-icon">⏸</span>
      <span className="subagent-approval-text">
        <b>{item.tool}</b> {item.summary}
      </span>
      <button
        className="primary-btn perm-btn"
        onClick={() => void respondPermission(sessionId, item.requestId, 'allow')}
      >
        Allow
      </button>
      <button
        className="ghost-btn perm-btn"
        onClick={() => void respondPermission(sessionId, item.requestId, 'deny')}
      >
        Deny
      </button>
    </div>
  )
}

/**
 * Read a Task tool result into clean display text. Async launches return
 * harness METADATA ("Async agent launched successfully… agentId…") that must
 * never reach the user — detect it and treat the run as still running in the
 * background instead.
 */
function parseTaskResult(result: unknown): {
  asyncLaunch: boolean
  text: string
  agentId?: string
} {
  let text = ''
  if (typeof result === 'string') text = result
  else if (Array.isArray(result)) {
    text = result
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n')
  } else if (result != null) text = JSON.stringify(result)
  // phrasing varies across harness versions — match loosely so the metadata
  // blob never leaks to the user as a "result"
  if (/async agent launched|agent launched successfully|launched .{0,20}in the background/i.test(text)) {
    const id = /agent[_ ]?id:?\s*['"]?([A-Za-z0-9._-]{6,})/i.exec(text)?.[1]
    return { asyncLaunch: true, text: '', agentId: id }
  }
  return { asyncLaunch: false, text: text.trim() }
}

function collectRuns(items: TranscriptItem[]): SubagentRun[] {
  const runs = new Map<string, SubagentRun>()
  const ensure = (id: string): SubagentRun => {
    let r = runs.get(id)
    if (!r) {
      r = {
        toolUseId: id,
        label: '',
        subagentType: 'subagent',
        status: 'running',
        blocks: [],
        toolCount: 0,
        pendingPermissions: []
      }
      runs.set(id, r)
    }
    return r
  }

  // pass 1: runs + their content blocks; map every tool_use id to its run
  const toolToRun = new Map<string, string>()
  for (const item of items) {
    if (item.type !== 'block') continue
    if (
      item.blockType === 'tool_use' &&
      (item.toolName === 'Task' || item.toolName === 'Agent') &&
      item.toolUseId &&
      !item.parentToolUseId // a subagent's own Task calls stay inside its thread
    ) {
      const run = ensure(item.toolUseId)
      const input = (item.toolInput ?? {}) as Record<string, unknown>
      run.label = String(input.description ?? input.prompt ?? '')
      run.subagentType = String(input.subagent_type ?? 'subagent')
      if (item.toolResult !== undefined) {
        const parsed = parseTaskResult(item.toolResult)
        if (item.toolResultError) {
          run.status = 'error'
          run.resultText = parsed.text || 'Subagent failed.'
        } else if (parsed.asyncLaunch) {
          run.status = 'background'
          run.agentId = parsed.agentId
        } else {
          run.status = 'done'
          run.resultText = parsed.text
        }
      }
    }
    if (item.parentToolUseId) {
      const run = ensure(item.parentToolUseId)
      run.blocks.push(item)
      if (item.blockType === 'tool_use') {
        run.toolCount++
        if (item.toolUseId) toolToRun.set(item.toolUseId, item.parentToolUseId)
      }
    }
  }

  // pass 2: background completion notes — the harness injects a notification
  // into the main conversation when an async agent finishes; match it to the
  // run by its agentId and flip background → done/failed with the real result
  for (const item of items) {
    if (item.type !== 'subagent-note') continue
    // bare "error" false-positives on results like "fixed the error handling"
    const failed = /\b(failed|errored|crashed|was killed|did not complete)\b/i.test(item.text)
    let matched = false
    for (const run of runs.values()) {
      if (run.status !== 'background' || !run.agentId) continue
      if (!item.text.includes(run.agentId)) continue
      run.status = failed ? 'error' : 'done'
      run.resultText = cleanNote(item.text)
      matched = true
    }
    if (!matched) {
      // agentId didn't parse (or the note omits it) — if exactly ONE run is
      // still in the background, the note can only be about that one; without
      // this it would show "running in background" forever
      const bg = [...runs.values()].filter((r) => r.status === 'background')
      if (bg.length === 1) {
        bg[0].status = failed ? 'error' : 'done'
        bg[0].resultText = cleanNote(item.text)
      }
    }
  }

  // pass 2.6: in real -p stream sessions the harness NEVER emits a completion
  // notification for async agents (verified against live session data — zero
  // notes across 4 background runs). The truthful "finished" signal is the
  // thread itself: it ends in a completed final TEXT block (the agent's
  // report) with nothing still awaiting a tool result. A new block arriving
  // later flips it right back to background, so this can't lie for long.
  for (const run of runs.values()) {
    if (run.status !== 'background') continue
    const last = run.blocks[run.blocks.length - 1]
    const pendingTool = run.blocks.some(
      (b) => b.blockType === 'tool_use' && b.final && b.toolResult === undefined
    )
    if (last && last.blockType === 'text' && last.final && last.text.trim() && !pendingTool) {
      run.status = 'done'
      run.resultText = last.text
    }
  }

  // pass 3: pending approvals — a run blocked on permission is NOT done
  for (const item of items) {
    if (item.type !== 'permission' || item.decision !== undefined) continue
    const runId = item.toolUseId ? toolToRun.get(item.toolUseId) : undefined
    if (!runId) continue
    const run = runs.get(runId)
    if (run) {
      run.pendingPermissions.push(item)
      if (run.status !== 'error') run.status = 'waiting'
    }
  }

  return [...runs.values()]
}

/** strip harness/tag scaffolding from an injected completion note */
function cleanNote(text: string): string {
  return text
    .replace(/<[^>]{1,40}>/g, ' ') // task-notification style tags
    .replace(/\b[A-Za-z0-9._-]{16,}\b/g, '') // ids/paths noise
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000)
}

function summarize(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    const hint = o.command ?? o.file_path ?? o.pattern ?? o.query ?? o.prompt ?? o.description
    if (typeof hint === 'string') return hint.slice(0, 90)
  }
  return ''
}

function pretty(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** the run a pending permission belongs to, for tagging main-chat cards */
export function subagentLabelForPermission(
  items: TranscriptItem[],
  permission: PermissionItem
): string | null {
  if (!permission.toolUseId) return null
  let parent: string | null = null
  for (const item of items) {
    if (item.type === 'block' && item.toolUseId === permission.toolUseId) {
      parent = item.parentToolUseId
      break
    }
  }
  if (!parent) return null
  for (const item of items) {
    if (
      item.type === 'block' &&
      item.toolUseId === parent &&
      (item.toolName === 'Task' || item.toolName === 'Agent')
    ) {
      const input = (item.toolInput ?? {}) as Record<string, unknown>
      return String(input.description ?? input.subagent_type ?? 'subagent')
    }
  }
  return null
}
