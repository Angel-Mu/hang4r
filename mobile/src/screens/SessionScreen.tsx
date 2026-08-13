import { useEffect, useRef, useState, type JSX } from 'react'
import { Icon } from '@shared/icons'
import { useApp } from '../state/store'
import type { Block, Item } from '../state/transcript'
import { Markdown } from '../components/Markdown'
import { useSwipeBack } from '../hooks/useSwipeBack'
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

function TranscriptSkeleton(): JSX.Element {
  return (
    <div className="skeleton-stack" aria-label="Loading conversation">
      <div className="skeleton skeleton-user" />
      <div className="skeleton" style={{ width: '85%' }} />
      <div className="skeleton" style={{ width: '70%' }} />
      <div className="skeleton skeleton-user" style={{ width: '45%' }} />
      <div className="skeleton" style={{ width: '78%' }} />
      <div className="skeleton" style={{ width: '60%' }} />
    </div>
  )
}

export function SessionScreen(): JSX.Element {
  const id = useApp((s) => s.openSessionId)!
  const session = useApp((s) => s.sessions.find((x) => x.id === id))
  const transcript = useApp((s) => s.transcripts[id])
  const loading = useApp((s) => s.transcriptLoading)
  const close = useApp((s) => s.closeSession)
  const sendPrompt = useApp((s) => s.sendPrompt)
  const interrupt = useApp((s) => s.interrupt)
  const conn = useApp((s) => s.conn)
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'chat' | 'diff'>('chat')
  const [nearBottom, setNearBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useSwipeBack<HTMLDivElement>(close)
  const itemCount = transcript?.items.length ?? 0

  const scrollToBottom = (smooth = false): void => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // follow the stream only while the user is at the bottom — jumping them
  // mid-read on every delta is what the nearBottom check prevents
  useEffect(() => {
    if (nearBottom) scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount, transcript, loading])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
  }

  // Slack-style auto-grow: content height up to the CSS max-height cap
  const autoGrow = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  const running = session?.status === 'running' || session?.status === 'starting'

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    requestAnimationFrame(autoGrow)
    void sendPrompt(text)
  }

  return (
    <div className="screen session-screen" ref={rootRef}>
      <header className="topbar" onClick={() => scrollToBottom(false)}>
        <button
          className="btn btn-ghost back-btn"
          onClick={(e) => {
            e.stopPropagation()
            close()
          }}
        >
          ‹ Back
        </button>
        <button
          className="topbar-title topbar-session topbar-title-btn"
          title="Scroll to top"
          onClick={(e) => {
            e.stopPropagation()
            scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
          }}
        >
          {session?.title ?? '…'}
        </button>
        <button
          className={'btn btn-ghost view-toggle' + (view === 'diff' ? ' view-toggle-active' : '')}
          aria-label="Diff review"
          onClick={(e) => {
            e.stopPropagation()
            setView(view === 'chat' ? 'diff' : 'chat')
          }}
        >
          ±
        </button>
        <span className={`status-dot status-${session?.status ?? 'idle'}`} />
      </header>
      {view === 'diff' ? (
        <DiffPanel sessionId={id} />
      ) : (
        <div className="transcript-wrap">
          <div className="transcript" ref={scrollRef} onScroll={onScroll}>
            {loading && itemCount === 0 && <TranscriptSkeleton />}
            {!loading && itemCount === 0 && (
              <p className="empty-note">
                Nothing recorded in this conversation yet. If it was driven outside hang4r, its
                history syncs in the next time the agent takes a turn.
              </p>
            )}
            {transcript?.items.map((item, i) => (
              <TranscriptItem key={i} item={item} sessionId={id} />
            ))}
            {running && <div className="working-note">agent is working…</div>}
          </div>
          {!nearBottom && (
            <button
              className="jump-bottom"
              aria-label="Jump to latest"
              onClick={() => scrollToBottom(true)}
            >
              <Icon name="arrow-down" size={17} />
            </button>
          )}
        </div>
      )}
      {view === 'chat' && (
        <footer className="composer">
          <textarea
            ref={inputRef}
            className="composer-input"
            placeholder={conn === 'online' ? 'Message the agent…' : 'desktop offline'}
            disabled={conn !== 'online'}
            value={draft}
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value)
              autoGrow()
            }}
            onFocus={() => setTimeout(() => scrollToBottom(false), 250)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
            }}
          />
          {running ? (
            <button className="btn btn-danger" onClick={() => void interrupt()}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!draft.trim() || conn !== 'online'}
              onClick={send}
            >
              Send
            </button>
          )}
        </footer>
      )}
    </div>
  )
}
