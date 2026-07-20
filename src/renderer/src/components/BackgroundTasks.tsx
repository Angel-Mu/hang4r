import { useEffect, useMemo, useState, type JSX } from 'react'
import { useHang4r } from '../state/store'
import type { TranscriptItem } from '../state/store'

type BgStatus = 'running' | 'done' | 'failed' | 'stopped' | 'ended'

interface BgTask {
  key: string
  id: string
  kind: 'bash' | 'workflow'
  command: string
  description?: string
  outputPath?: string
  /** for workflows (no log file) — the tool result text to show inline */
  resultText?: string
  status: BgStatus
}

/**
 * Background tasks: `Bash` tool calls the agent launched with run_in_background.
 * Claude's tool_result reports "Command running in background with ID: <id>.
 * Output is being written to: <file>" — we surface those here with live output,
 * since they're otherwise invisible (the Subagents tab only shows Task subagents).
 */
function collectTasks(items: TranscriptItem[]): BgTask[] {
  const tasks: BgTask[] = []
  const killed = new Set<string>()
  // truthful completion (same philosophy as the subagent-thread fix): the
  // stream never flips a launch's own tool_result, so completion must be read
  // from LATER evidence — BashOutput/TaskOutput results with an exit code, and
  // harness completion notes (subagent-note items) naming the task id
  const finished = new Map<string, BgStatus>()
  const evidence = (id: string, text: string): void => {
    if (!id || !text.includes(id)) return
    if (/exit code:?\s*0\b|completed successfully|\bcompleted\b(?!.*exit code)/i.test(text)) {
      finished.set(id, 'done')
    } else if (/exit code:?\s*[1-9]|\bfailed\b|\bkilled\b/i.test(text)) {
      finished.set(id, 'failed')
    }
  }
  for (const item of items) {
    if (item.type === 'subagent-note') {
      for (const t of tasks) evidence(t.id, item.text)
      continue
    }
    if (item.type !== 'block' || item.blockType !== 'tool_use') continue
    // KillShell / KillBash marks a background shell as stopped
    if ((item.toolName === 'KillShell' || item.toolName === 'KillBash') && item.toolInput) {
      const id = (item.toolInput as { shell_id?: string; bash_id?: string }).shell_id
      const bid = (item.toolInput as { bash_id?: string }).bash_id
      if (id) killed.add(id)
      if (bid) killed.add(bid)
      continue
    }
    const res =
      typeof item.toolResult === 'string' ? item.toolResult : JSON.stringify(item.toolResult ?? '')

    // the agent checking on a task reveals its true state
    if (item.toolName === 'BashOutput' || item.toolName === 'TaskOutput') {
      const ref = (item.toolInput as { bash_id?: string; shell_id?: string; task_id?: string }) ?? {}
      const refId = ref.bash_id ?? ref.shell_id ?? ref.task_id
      if (refId && res) evidence(refId, `${refId} ${res.slice(0, 2000)}`)
      continue
    }

    // Workflow tool (e.g. /deep-research fans out many agents in the background)
    if (item.toolName === 'Workflow') {
      const meta = (item.toolInput as { name?: string; description?: string }) ?? {}
      const runId = /Run ID:\s*(\S+)/i.exec(res)?.[1] ?? item.toolUseId ?? '?'
      tasks.push({
        key: item.toolUseId ?? runId,
        id: runId,
        kind: 'workflow',
        command: meta.name || 'Workflow',
        description: meta.description,
        resultText: res.slice(0, 2000),
        status: 'running'
      })
      continue
    }

    // Bash run_in_background
    if (item.toolName !== 'Bash' || !item.toolInput) continue
    const input = item.toolInput as { command?: string; description?: string; run_in_background?: boolean }
    if (!input.run_in_background) continue
    const id = /background with ID:\s*([^\s.]+)/i.exec(res)?.[1] ?? item.toolUseId ?? '?'
    const outputPath = /written to:\s*(\S+)/i.exec(res)?.[1]
    tasks.push({
      key: item.toolUseId ?? id,
      id,
      kind: 'bash',
      command: input.command ?? '',
      description: input.description,
      outputPath: outputPath?.replace(/[.,]$/, ''),
      status: 'running'
    })
  }
  return tasks.map((t) => ({
    ...t,
    status: killed.has(t.id) ? 'stopped' : (finished.get(t.id) ?? t.status)
  }))
}

interface AgentTodo {
  id: string
  subject: string
  status: string
}

/**
 * The agent's structured task list (TaskCreate/TaskUpdate tools — the modern
 * successor to TodoWrite). Reconstructed from the transcript: creations bind
 * ids from the tool RESULT ("Created task #3"), updates patch status/subject.
 * Angel's report: the conversation showed these tools running while this
 * panel claimed "no background tasks" — the list rendered nowhere.
 */
function collectAgentTodos(items: TranscriptItem[]): AgentTodo[] {
  const todos = new Map<string, AgentTodo>()
  for (const item of items) {
    if (item.type !== 'block' || item.blockType !== 'tool_use') continue
    const res =
      typeof item.toolResult === 'string' ? item.toolResult : JSON.stringify(item.toolResult ?? '')
    if (item.toolName === 'TaskCreate') {
      const input =
        (item.toolInput as { subject?: string; description?: string; tasks?: { subject?: string }[] }) ?? {}
      const ids = [...res.matchAll(/#(\d+)/g)].map((m) => m[1])
      const subjects = input.tasks?.map((t) => t.subject ?? '') ?? [
        input.subject ?? input.description ?? ''
      ]
      ids.forEach((id, i) =>
        todos.set(id, { id, subject: subjects[i] || subjects[0] || `task #${id}`, status: 'pending' })
      )
    } else if (item.toolName === 'TaskUpdate') {
      const input = (item.toolInput as { taskId?: string; status?: string; subject?: string }) ?? {}
      const id = String(input.taskId ?? '')
      if (!id) continue
      const cur = todos.get(id) ?? { id, subject: `task #${id}`, status: 'pending' }
      todos.set(id, {
        ...cur,
        subject: input.subject ?? cur.subject,
        status: input.status ?? cur.status
      })
    }
  }
  return [...todos.values()].filter((t) => t.status !== 'deleted')
}

const TODO_GLYPH: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●'
}

export function BackgroundTasks({ sessionId }: { sessionId: string }): JSX.Element {
  const transcript = useHang4r((s) => s.transcripts[sessionId])
  const status = useHang4r((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  // background commands are CHILDREN of the agent process — with no live
  // process (e.g. a replayed session after an app restart) nothing can still
  // be running, whatever the transcript says. This is the truthful signal the
  // stream itself never provides (verified against real session data).
  const [agentAlive, setAgentAlive] = useState(true)
  useEffect(() => {
    let alive = true
    void window.hang4r.agentAlive(sessionId).then((v) => {
      if (alive) setAgentAlive(v)
    })
    return () => {
      alive = false
    }
  }, [sessionId, status, transcript])
  const tasks = useMemo(() => {
    const collected = collectTasks(transcript?.items ?? [])
    return agentAlive
      ? collected
      : collected.map((t) => (t.status === 'running' ? { ...t, status: 'ended' as const } : t))
  }, [transcript, agentAlive])

  const todos = useMemo(() => collectAgentTodos(transcript?.items ?? []), [transcript])

  if (tasks.length === 0 && todos.length === 0) {
    return (
      <div className="diff-empty">
        No tasks yet. The agent&apos;s task list (TaskCreate/TaskUpdate) shows here as it
        plans work, and so does anything it runs in the background (run_in_background
        commands, Workflows like /deep-research) with live output.
      </div>
    )
  }
  return (
    <div className="bgtasks-view">
      {todos.length > 0 && (
        <>
          <div className="bgtasks-header">
            Agent task list ({todos.filter((t) => t.status === 'completed').length}/{todos.length})
          </div>
          <div className="agent-todos">
            {todos.map((t) => (
              <div key={t.id} className={'todo-row todo-' + t.status}>
                <span className="todo-glyph">{TODO_GLYPH[t.status] ?? '○'}</span>
                <span className="todo-subject">{t.subject}</span>
                <span className="todo-status">{t.status.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {tasks.length > 0 && (
        <div className="bgtasks-header">
          Background tasks ({tasks.length})
          {agentAlive && tasks.some((t) => t.status === 'running') && (
            <button
              className="ghost-btn stop-turn-btn"
              title="Stops the whole turn — background commands are the agent's children; stopping the turn is the only protocol-supported kill"
              onClick={() => void useHang4r.getState().interrupt(sessionId)}
            >
              ■ Stop turn
            </button>
          )}
        </div>
      )}
      {tasks.map((t) => (
        <BgTaskRow key={t.key} task={t} />
      ))}
    </div>
  )
}

function BgTaskRow({ task }: { task: BgTask }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [output, setOutput] = useState('')
  useEffect(() => {
    if (!open || !task.outputPath) return
    let alive = true
    const load = (): void => {
      void window.hang4r.tailFile(task.outputPath!).then((t) => {
        if (alive) setOutput(t)
      })
    }
    load()
    // poll while open (background tasks keep writing)
    const iv = setInterval(load, 1500)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [open, task.outputPath])

  const body = task.kind === 'workflow' ? task.resultText || 'Workflow running…' : output
  const STATUS_LABEL: Record<BgStatus, string> = {
    running: 'running',
    done: 'done',
    failed: 'failed',
    stopped: 'stopped',
    ended: 'ended'
  }
  return (
    <div className={'bgtask' + (task.status !== 'running' ? ' bgtask-ended' : '')}>
      <button className="bgtask-head" onClick={() => setOpen((o) => !o)}>
        <span className="bgtask-caret">{open ? '▾' : '▸'}</span>
        <span className={'bgtask-dot dot-' + task.status} />
        <span className="bgtask-kind">{task.kind === 'workflow' ? 'workflow' : 'bash'}</span>
        <span className="bgtask-cmd" title={task.command}>
          {task.description || task.command}
        </span>
        <span className="bgtask-id">{task.id}</span>
        <span className={'bgtask-status bgtask-status-' + task.status}>{STATUS_LABEL[task.status]}</span>
      </button>
      {open && (
        <pre className="bgtask-output">
          {body || (task.outputPath ? '…waiting for output' : 'No output captured.')}
        </pre>
      )}
    </div>
  )
}
