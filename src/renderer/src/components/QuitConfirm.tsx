import { useEffect, useState, type JSX } from 'react'
import type { LiveWorkItem } from '../../../shared/protocol'

/**
 * Cursor-style confirm (replaces the native macOS warning box, which can't be
 * styled) for anything that cuts live work short: bold title, plain sentence,
 * right-aligned Cancel (Esc) / go (↩). Main sends quit:confirm with the `kind`
 * — quitting, or restarting to finish an update.
 */
export function QuitConfirm(): JSX.Element | null {
  const [info, setInfo] = useState<{
    message: string
    detail: string
    kind?: 'quit' | 'update'
    items?: LiveWorkItem[]
  } | null>(null)
  // rows the user has stopped, kept out of the list without waiting for a
  // re-probe — stopping is one-way, so an optimistic strike-off can't be wrong
  const [stopped, setStopped] = useState<string[]>([])

  useEffect(() => {
    if (info) setStopped([])
  }, [info])

  useEffect(() => window.hang4r.onQuitConfirm(setInfo), [])

  const answer = (quit: boolean): void => {
    setInfo(null)
    void window.hang4r.answerQuitConfirm(quit)
  }

  useEffect(() => {
    if (!info) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answer(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        answer(true)
      }
    }
    // capture phase so Esc can't also close panels underneath
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info])

  if (!info) return null
  const updating = info.kind === 'update'
  const title = updating ? 'Restart to update?' : 'Quit hang4r?'
  const live = (info.items ?? []).filter((it) => !stopped.includes(it.kind + it.id))
  const stopOne = (it: LiveWorkItem): void => {
    setStopped((s) => [...s, it.kind + it.id])
    void window.hang4r.stopLiveWork(it)
  }
  const KIND_NOTE: Record<LiveWorkItem['kind'], string> = {
    agent: 'agent working',
    terminal: 'terminal',
    detached: 'detached process',
    task: 'background task'
  }
  return (
    <div className="dialog-backdrop quit-backdrop">
      <div className="quit-dialog" role="alertdialog" aria-label={title}>
        <div className="quit-title">{title}</div>
        <div className="quit-message">
          {live.length === 0 ? 'Nothing is running any more.' : `${info.message} ${info.detail}`}
        </div>
        {live.length > 0 && (
          <div className="quit-live">
            {live.map((it) => (
              <div className="quit-live-row" key={it.kind + it.id}>
                <span className="quit-live-label">{it.label}</span>
                <span className="quit-live-kind">{KIND_NOTE[it.kind]}</span>
                <button className="ghost-btn quit-live-stop" onClick={() => stopOne(it)}>
                  ■ Stop
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="quit-actions">
          <button className="ghost-btn quit-cancel" onClick={() => answer(false)}>
            Cancel <span className="quit-key">Esc</span>
          </button>
          <button className="primary-btn quit-go" onClick={() => answer(true)}>
            {updating ? 'Restart' : 'Quit'} <span className="quit-key">↩</span>
          </button>
        </div>
      </div>
    </div>
  )
}
