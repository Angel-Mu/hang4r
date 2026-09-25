import { useMemo, useState, type JSX } from 'react'
import { collectAgentTodos, type AgentTodo, type TodoSource } from '@shared/agentTodos'
import { Icon } from '@shared/icons'
import type { Transcript } from '../state/transcript'

const PLAN_STATUS = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed'
} as const

/** Claude's board comes from TaskCreate/TaskUpdate or its last markdown
 *  checklist (shared with the desktop); Codex reports its plan as its own
 *  event, which is the better source whenever one exists. */
function agentTodos(t: Transcript | undefined): AgentTodo[] {
  if (!t) return []
  if (t.plan.length) {
    return t.plan.map((p, i) => ({
      id: `plan-${i}`,
      subject: p.step,
      status: PLAN_STATUS[p.status]
    }))
  }
  const sources: TodoSource[] = []
  for (const it of t.items) {
    if (it.kind !== 'assistant') continue
    for (const b of it.blocks) {
      if (!b) continue
      if (b.type === 'tool')
        sources.push({
          kind: 'tool',
          name: b.call.name,
          input: b.call.input,
          result: b.call.result
        })
      else if (b.type === 'text') sources.push({ kind: 'text', text: b.text })
    }
  }
  return collectAgentTodos(sources)
}

function TodoMark({ status }: { status: string }): JSX.Element {
  if (status === 'completed') return <Icon name="check" size={14} />
  return <span className={'todo-dot' + (status === 'in_progress' ? ' todo-dot-active' : '')} />
}

/** Desktop's TaskProgress strip: count, bar, current task — tap for the list. */
export function TaskProgress({
  transcript
}: {
  transcript: Transcript | undefined
}): JSX.Element | null {
  const todos = useMemo(() => agentTodos(transcript), [transcript])
  const [open, setOpen] = useState(false)

  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  // every task finished and nothing running: the list is history, not progress
  if (done === todos.length && !current) return null

  return (
    <>
      <button className="task-progress" onClick={() => setOpen(true)}>
        <span className="task-progress-count">
          Tasks {done}/{todos.length}
        </span>
        <span className="task-progress-bar" aria-hidden>
          <span style={{ width: `${Math.round((done / todos.length) * 100)}%` }} />
        </span>
        {current && <span className="task-progress-current">{current.subject}</span>}
      </button>
      {open && (
        <>
          <div className="sheet-scrim" onClick={() => setOpen(false)} />
          <div className="sheet task-sheet">
            <div className="sheet-grab" />
            <p className="sheet-title">
              Tasks {done}/{todos.length}
            </p>
            <ul className="todo-list">
              {todos.map((t) => (
                <li key={t.id} className={`todo-row todo-${t.status}`}>
                  <TodoMark status={t.status} />
                  <span className="todo-subject">{t.subject}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  )
}
