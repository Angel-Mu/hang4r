import { useEffect, useRef, useState, type JSX } from 'react'
import { useApp } from '../state/store'
import type { Block, Item } from '../state/transcript'
import { Markdown } from '../components/Markdown'
import { DiffPanel } from './DiffPanel'

function ToolChip({ block }: { block: Extract<Block, { type: 'tool' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const c = block.call
  return (
    <div className={'tool-chip' + (c.isError ? ' tool-error' : '')}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-status">{c.done ? (c.isError ? '✗' : '✓') : '…'}</span>
        <span className="tool-name">{c.name}</span>
      </button>
      {open && (
        <pre className="tool-detail">
          {typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 2)}
          {c.done && '\n— result —\n'}
          {c.done &&
            (typeof c.result === 'string' ? c.result : JSON.stringify(c.result, null, 2))?.slice(
              0,
              2000
            )}
        </pre>
      )}
    </div>
  )
}

function PermissionCard({ item, sessionId }: { item: Extract<Item, { kind: 'permission' }>; sessionId: string }): JSX.Element {
  const respond = useApp((s) => s.respondPermission)
  if (item.decision) {
    return (
      <div className="perm-card perm-resolved">
        <span>
          {item.tool}: {item.summary}
        </span>
        <b>{item.decision.startsWith('allow') ? 'Allowed' : 'Denied'}</b>
      </div>
    )
  }
  return (
    <div className="perm-card">
      <p className="perm-title">Approval needed</p>
      <p className="perm-summary">
        <b>{item.tool}</b> — {item.summary}
      </p>
      {item.detail && <pre className="perm-detail">{item.detail.slice(0, 1200)}</pre>}
      <div className="perm-actions">
        {item.options.includes('allow') && (
          <button
            className="btn btn-primary"
            onClick={() => void respond(sessionId, item.requestId, 'allow')}
          >
            Allow
          </button>
        )}
        {item.options.includes('allow_always') && (
          <button
            className="btn"
            onClick={() => void respond(sessionId, item.requestId, 'allow_always')}
          >
            Always
          </button>
        )}
        <button
          className="btn btn-danger"
          onClick={() => void respond(sessionId, item.requestId, 'deny')}
        >
          Deny
        </button>
      </div>
    </div>
  )
}

function QuestionCard({ item, sessionId }: { item: Extract<Item, { kind: 'question' }>; sessionId: string }): JSX.Element {
  const respond = useApp((s) => s.respondQuestion)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  if (item.answered) {
    return <div className="perm-card perm-resolved">Question answered ✓</div>
  }
  const allPicked = item.questions.every((q) => (picked[q.id] ?? []).length > 0)
  return (
    <div className="perm-card">
      <p className="perm-title">{item.title ?? 'The agent has a question'}</p>
      {item.questions.map((q) => (
        <div key={q.id} className="question-block">
          <p className="perm-summary">{q.prompt}</p>
          <div className="question-options">
            {q.options.map((o) => {
              const selected = (picked[q.id] ?? []).includes(o.id)
              return (
                <button
                  key={o.id}
                  className={'btn btn-option' + (selected ? ' btn-selected' : '')}
                  onClick={() =>
                    setPicked((p) => {
                      const cur = p[q.id] ?? []
                      const next = q.allowMultiple
                        ? selected
                          ? cur.filter((x) => x !== o.id)
                          : [...cur, o.id]
                        : [o.id]
                      return { ...p, [q.id]: next }
                    })
                  }
                >
                  {o.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <button
        className="btn btn-primary"
        disabled={!allPicked}
        onClick={() =>
          void respond(
            sessionId,
            item.requestId,
            item.questions.map((q) => ({ questionId: q.id, optionIds: picked[q.id] }))
          )
        }
      >
        Answer
      </button>
    </div>
  )
}

function TranscriptItem({ item, sessionId }: { item: Item; sessionId: string }): JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return <div className="msg msg-user">{item.text}</div>
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          {item.blocks.map((b, i) => {
            if (!b) return null
            if (b.type === 'text') return b.text ? <Markdown key={i} text={b.text} /> : null
            if (b.type === 'thinking')
              return b.text ? (
                <p key={i} className="msg-thinking">
                  {b.text}
                </p>
              ) : null
            return <ToolChip key={i} block={b} />
          })}
        </div>
      )
    case 'note':
      return <div className={'msg-note' + (item.isError ? ' msg-note-error' : '')}>{item.text}</div>
    case 'permission':
      return <PermissionCard item={item} sessionId={sessionId} />
    case 'question':
      return <QuestionCard item={item} sessionId={sessionId} />
    case 'turn-end':
      if (item.isError)
        return <div className="msg-note msg-note-error">✗ {item.errorMessage ?? 'turn failed'}</div>
      return <div className="turn-divider" />
    default:
      return null
  }
}

export function SessionScreen(): JSX.Element {
  const id = useApp((s) => s.openSessionId)!
  const session = useApp((s) => s.sessions.find((x) => x.id === id))
  const transcript = useApp((s) => s.transcripts[id])
  const close = useApp((s) => s.closeSession)
  const sendPrompt = useApp((s) => s.sendPrompt)
  const interrupt = useApp((s) => s.interrupt)
  const conn = useApp((s) => s.conn)
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'chat' | 'diff'>('chat')
  const scrollRef = useRef<HTMLDivElement>(null)
  const itemCount = transcript?.items.length ?? 0

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [itemCount, transcript])

  const running = session?.status === 'running' || session?.status === 'starting'

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void sendPrompt(text)
  }

  return (
    <div className="screen session-screen">
      <header className="topbar">
        <button className="btn btn-ghost" onClick={close}>
          ‹ Back
        </button>
        <span className="topbar-title topbar-session">{session?.title ?? '…'}</span>
        <button
          className={'btn btn-ghost view-toggle' + (view === 'diff' ? ' view-toggle-active' : '')}
          onClick={() => setView(view === 'chat' ? 'diff' : 'chat')}
        >
          ±
        </button>
        <span className={`status-dot status-${session?.status ?? 'idle'}`} />
      </header>
      {view === 'diff' ? (
        <DiffPanel sessionId={id} />
      ) : (
        <div className="transcript" ref={scrollRef}>
          {!transcript && <p className="empty-note">Loading conversation…</p>}
          {transcript?.items.map((item, i) => (
            <TranscriptItem key={i} item={item} sessionId={id} />
          ))}
          {running && <div className="working-note">agent is working…</div>}
        </div>
      )}
      {view === 'chat' && (
      <footer className="composer">
        <textarea
          className="composer-input"
          placeholder={conn === 'online' ? 'Message the agent…' : 'desktop offline'}
          disabled={conn !== 'online'}
          value={draft}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          }}
        />
        {running ? (
          <button className="btn btn-danger" onClick={() => void interrupt()}>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!draft.trim() || conn !== 'online'} onClick={send}>
            Send
          </button>
        )}
      </footer>
      )}
    </div>
  )
}
