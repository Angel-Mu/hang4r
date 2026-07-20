import { useEffect, useRef, useState, type JSX } from 'react'
import { useHang4r, type TranscriptItem } from '../state/store'

/**
 * Global "N Working" monitor: every running agent across all workspaces. Click
 * the label to jump straight to the running session (or expand the list when
 * several are running); Stop All interrupts them; × hides it for this run.
 */
export function WorkingPanel(): JSX.Element | null {
  const sessions = useHang4r((s) => s.sessions)
  const transcripts = useHang4r((s) => s.transcripts)
  const openSession = useHang4r((s) => s.openSession)
  const interrupt = useHang4r((s) => s.interrupt)
  const [open, setOpen] = useState(false)
  // 'shown' -> visible; 'fading' -> opacity transitioning out; 'hidden' -> fully gone
  const [phase, setPhase] = useState<'shown' | 'fading' | 'hidden'>('shown')

  const running = sessions.filter((s) => s.status === 'running' || s.status === 'starting')

  const hoverRef = useRef(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevCount = useRef(0)

  const clearTimers = (): void => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    hideTimerRef.current = null
    fadeTimerRef.current = null
  }

  // start (or restart) the 5s countdown to fade-and-hide; no-op while hovering
  const scheduleAutoHide = (): void => {
    clearTimers()
    if (hoverRef.current) return
    hideTimerRef.current = setTimeout(() => {
      setPhase('fading')
      fadeTimerRef.current = setTimeout(() => setPhase('hidden'), 260)
    }, 5000)
  }

  // reappear whenever the running-agent count changes (including 0 -> >0)
  useEffect(() => {
    if (running.length !== prevCount.current) {
      prevCount.current = running.length
      if (running.length > 0) {
        setPhase('shown')
        scheduleAutoHide()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running.length])

  useEffect(() => clearTimers, [])

  if (running.length === 0 || phase === 'hidden') return null

  const onMouseEnter = (): void => {
    hoverRef.current = true
    clearTimers()
  }
  const onMouseLeave = (): void => {
    hoverRef.current = false
    if (phase === 'shown') scheduleAutoHide()
  }
  const onClose = (): void => {
    clearTimers()
    setPhase('fading')
    fadeTimerRef.current = setTimeout(() => setPhase('hidden'), 260)
  }

  const latestActivity = (sessionId: string): string => {
    const items = transcripts[sessionId]?.items ?? []
    for (let i = items.length - 1; i >= 0; i--) {
      const it: TranscriptItem = items[i]
      if (it.type === 'block' && it.blockType === 'tool_use') {
        return `${it.toolName ?? 'tool'} ${summarize(it.toolInput)}`
      }
      if (it.type === 'block' && it.blockType === 'text' && it.text) {
        return it.text.slice(0, 70)
      }
    }
    return 'working…'
  }

  // one running → jump straight to it; several → expand the list
  const onLabel = (): void => {
    if (running.length === 1) void openSession(running[0].id)
    else setOpen((o) => !o)
  }

  return (
    <div
      className={`working-panel${phase === 'fading' ? ' working-panel-fading' : ''}`}
      data-testid="working-panel"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="working-header">
        <button
          className="working-toggle"
          title={running.length === 1 ? 'Jump to the running session' : 'Show running sessions'}
          onClick={onLabel}
        >
          <span className="gauge-dot gauge-dot-pulse working-dot" />
          {running.length} Working
        </button>
        <button
          className="ghost-btn working-stop-all"
          onClick={() => running.forEach((s) => void interrupt(s.id))}
        >
          Stop All
        </button>
        <button className="working-hide" title="Hide (agents keep running)" onClick={onClose}>
          ✕
        </button>
      </div>
      {open && running.length > 1 && (
        <div className="working-body">
          {running.map((s) => (
            <button key={s.id} className="working-row" onClick={() => void openSession(s.id)}>
              <span className="status-dot status-running" />
              <span className="working-title">{s.title}</span>
              <span className="working-activity">{latestActivity(s.id)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function summarize(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    const hint = o.command ?? o.file_path ?? o.description ?? o.query
    if (typeof hint === 'string') return hint.slice(0, 50)
  }
  return ''
}
