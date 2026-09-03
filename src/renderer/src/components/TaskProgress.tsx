import type { JSX } from 'react'
import { useMemo } from 'react'
import { collectAgentTodos } from './BackgroundTasks'
import { useHang4r, type TranscriptItem } from '../state/store'

/**
 * The agent's task list, always in view above the composer.
 *
 * The Tasks panel already reconstructed this, but you had to open a side panel
 * to learn where a long turn had got to — Angel asked for what Hermes shows: the
 * count and the current item, on screen the whole time.
 */
export function TaskProgress({
  sessionId,
  items
}: {
  sessionId: string
  items: TranscriptItem[]
}): JSX.Element | null {
  const todos = useMemo(() => collectAgentTodos(items), [items])
  const openTasks = useHang4r((s) => s.openTasks)

  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  // every task finished and nothing running: the list is history, not progress
  if (done === todos.length && !current) return null

  return (
    <button
      className="task-progress"
      title="Open the Tasks panel"
      onClick={() => openTasks(sessionId)}
    >
      <span className="task-progress-count">
        Tasks {done}/{todos.length}
      </span>
      <span className="task-progress-bar" aria-hidden>
        <span style={{ width: `${Math.round((done / todos.length) * 100)}%` }} />
      </span>
      {current && <span className="task-progress-current">{current.subject}</span>}
    </button>
  )
}
