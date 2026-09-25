/**
 * The agent's task board, reconstructed from its transcript. Shared by the
 * desktop and the phone so the two boards cannot disagree; each side maps its
 * own transcript shape onto TodoSource.
 */
export interface AgentTodo {
  id: string
  subject: string
  status: string
}

/** One transcript entry, as the board sees it: a tool call, or top-level
 *  (non-subagent) assistant text. Anything else is omitted by the caller. */
export type TodoSource =
  { kind: 'tool'; name: string; input: unknown; result: unknown } | { kind: 'text'; text: string }

/**
 * The agent's checklist written as markdown, when there is no tool to read.
 *
 * TaskCreate/TaskUpdate were retired from the CLI around 2026-08-14 — Angel's
 * store has not seen one since, and a current session's tool list does not
 * contain them. The agent still writes the board as `- [ ]` / `- [x]` lines, so
 * that is what this reads.
 *
 * Only the LAST message carrying a checklist counts: the board is a running
 * restatement, not an append-only log.
 */
function todosFromMarkdown(sources: TodoSource[]): AgentTodo[] {
  for (let i = sources.length - 1; i >= 0; i--) {
    const it = sources[i]
    if (it.kind !== 'text') continue
    const rows = [...(it.text ?? '').matchAll(/^[ \t]*[-*]\s+\[([ xX])\]\s+(.+)$/gm)]
    if (rows.length < 2) continue // one stray checkbox is not a board
    return rows.map((m, n) => ({
      id: `md-${n}`,
      subject: m[2].trim(),
      status: m[1].toLowerCase() === 'x' ? 'completed' : 'pending'
    }))
  }
  return []
}

/**
 * The agent's structured task list (TaskCreate/TaskUpdate tools — the modern
 * successor to TodoWrite). Reconstructed from the transcript: creations bind
 * ids from the tool RESULT ("Created task #3"), updates patch status/subject.
 * Angel's report: the conversation showed these tools running while this
 * panel claimed "no background tasks" — the list rendered nowhere.
 */
export function collectAgentTodos(sources: TodoSource[]): AgentTodo[] {
  const todos = new Map<string, AgentTodo>()
  for (const item of sources) {
    if (item.kind !== 'tool') continue
    const res = typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? '')
    if (item.name === 'TaskCreate') {
      const input =
        (item.input as {
          subject?: string
          description?: string
          tasks?: { subject?: string }[]
        }) ?? {}
      const ids = [...res.matchAll(/#(\d+)/g)].map((m) => m[1])
      const subjects = input.tasks?.map((t) => t.subject ?? '') ?? [
        input.subject ?? input.description ?? ''
      ]
      ids.forEach((id, i) =>
        todos.set(id, {
          id,
          subject: subjects[i] || subjects[0] || `task #${id}`,
          status: 'pending'
        })
      )
    } else if (item.name === 'TaskUpdate') {
      const input = (item.input as { taskId?: string; status?: string; subject?: string }) ?? {}
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
  const fromTools = [...todos.values()].filter((t) => t.status !== 'deleted')
  return fromTools.length ? fromTools : todosFromMarkdown(sources)
}
