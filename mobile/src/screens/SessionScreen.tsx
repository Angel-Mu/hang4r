import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Icon } from '@shared/icons'
import { quickReplies, type QuickQuestion } from '@shared/quickReplies'
import { needsDesktop, useApp } from '../state/store'
import { canEditUser, userOccurrences, type Block, type Item } from '../state/transcript'
import { Markdown } from '../components/Markdown'
import { useNav } from '../components/PushScreen'
import { SessionInfoSheet } from '../components/SessionInfoSheet'
import { DiffPanel } from './DiffPanel'
import { TaskProgress } from '../components/TaskProgress'
import { AttachButton, PendingImages } from '../components/ImageAttach'
import { IMAGE_ONLY_PROMPT, useImageAttachments } from '../hooks/useImageAttachments'

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
        <b>
          {item.decision === 'cancelled'
            ? 'Cancelled'
            : item.decision.startsWith('allow')
              ? 'Allowed'
              : 'Denied'}
        </b>
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

/** Desktop's QuestionCard: a single single-choice question answers on tap;
 *  anything multi toggles then submits. Once settled it shows what was picked,
 *  or that the turn ended before anyone answered. */
function QuestionCard({ item, sessionId }: { item: Extract<Item, { kind: 'question' }>; sessionId: string }): JSX.Element {
  const respond = useApp((s) => s.respondQuestion)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const live = !item.answered && !item.cancelled
  const oneShot = item.questions.length === 1 && !item.questions[0].allowMultiple
  const allPicked = item.questions.every((q) => (picked[q.id] ?? []).length > 0)
  const chosen = (qId: string): string => {
    const q = item.questions.find((x) => x.id === qId)
    const ids = item.answers?.find((a) => a.questionId === qId)?.optionIds ?? []
    return ids.map((id) => q?.options.find((o) => o.id === id)?.label ?? id).join(', ')
  }
  return (
    <div className={'perm-card question-card' + (live ? '' : ' question-decided')}>
      <p className="perm-title">
        {item.title ?? 'The agent has a question'}
        {item.cancelled && <span className="question-status"> · cancelled</span>}
      </p>
      {item.questions.map((q) => (
        <div key={q.id} className="question-block">
          <p className="perm-summary">{q.prompt}</p>
          {live ? (
            <div className="question-options">
              {q.options.map((o) => {
                const selected = (picked[q.id] ?? []).includes(o.id)
                if (oneShot) {
                  return (
                    <button
                      key={o.id}
                      className="btn btn-option"
                      onClick={() =>
                        void respond(sessionId, item.requestId, [{ questionId: q.id, optionIds: [o.id] }])
                      }
                    >
                      {o.label}
                    </button>
                  )
                }
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
          ) : (
            <p className="question-answer">
              {item.cancelled
                ? 'Cancelled — the turn ended before an answer'
                : item.answers
                  ? `Answered: ${chosen(q.id) || '(no answer)'}`
                  : 'Answered'}
            </p>
          )}
        </div>
      ))}
      {live && !oneShot && (
        <button
          className="btn btn-primary"
          disabled={!allPicked}
          onClick={() =>
            void respond(
              sessionId,
              item.requestId,
              item.questions.map((q) => ({ questionId: q.id, optionIds: picked[q.id] ?? [] }))
            )
          }
        >
          Answer
        </button>
      )}
    </div>
  )
}

/** Desktop's UserMessageCard: the wording is honest per backend — Claude and
 *  Codex truncate, Cursor can only resend as a new turn. */
function UserMessage({
  item,
  occurrenceFromEnd
}: {
  item: Extract<Item, { kind: 'user' }>
  occurrenceFromEnd: number
}): JSX.Element {
  const backend = useApp((s) => s.sessions.find((x) => x.id === s.openSessionId)?.backend)
  const online = useApp((s) => s.conn === 'online')
  const rewind = useApp((s) => s.rewind)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const appendOnly = backend === 'cursor'
  const copy = appendOnly
    ? {
        hint: 'Cursor can’t rewind history — this asks again as a new turn; the earlier messages stay',
        send: 'Resend as new turn',
        busy: 'Sending…'
      }
    : {
        hint: 'Restarts the conversation from here — later messages are discarded',
        send: 'Send from here',
        busy: 'Rewinding…'
      }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      await rewind(item.text, occurrenceFromEnd, text)
      setEditing(false)
    } catch (e) {
      setError(needsDesktop(e))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="msg-edit">
        <textarea
          className="msg-edit-input"
          value={draft}
          autoFocus
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
        />
        <p className="msg-edit-hint">{copy.hint}</p>
        {error && <p className="sheet-error msg-edit-error">{error}</p>}
        <div className="msg-edit-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !draft.trim() || !online}
            onClick={() => void send()}
          >
            {busy ? copy.busy : copy.send}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="msg-user-row">
      {canEditUser(item) && (
        <button
          className="msg-edit-btn"
          aria-label={appendOnly ? 'Edit and resend as a new turn' : 'Edit message'}
          disabled={!online}
          onClick={() => {
            setDraft(item.text)
            setError(null)
            setEditing(true)
          }}
        >
          <Icon name="pencil" size={14} />
        </button>
      )}
      <div className="msg msg-user">
        {item.images && item.images.length > 0 && (
          <div className="msg-images">
            {item.images.map((img, i) => (
              <img key={i} src={`data:${img.mediaType};base64,${img.base64}`} alt="" />
            ))}
          </div>
        )}
        {item.text}
      </div>
    </div>
  )
}

function TranscriptItem({
  item,
  sessionId,
  occurrenceFromEnd
}: {
  item: Item
  sessionId: string
  occurrenceFromEnd?: number
}): JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} occurrenceFromEnd={occurrenceFromEnd ?? 0} />
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

/** Options offered in the agent's LAST words — the desktop's rule: anything
 *  said after them (a tool call, a note) means they are no longer the question. */
function lastQuickQuestion(items: Item[] | undefined): QuickQuestion | null {
  if (!items) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'turn-end') continue
    if (it.kind !== 'assistant') return null
    const last = [...it.blocks].reverse().find((b) => b)
    if (last?.type !== 'text') return null
    const found = quickReplies(last.text)
    return found.options.length ? found : null
  }
  return null
}

const NO_QUEUE: never[] = []
/** start fetching the older page this far before the top is reached */
const LOAD_OLDER_PX = 400

/** Stable per item, so a prepended page doesn't remount everything below it;
 *  cached transcripts predate keys and fall back to position. */
function itemKeys(items: Item[]): string[] {
  const seen = new Set<string>()
  return items.map((it, i) => {
    let k = it.key ?? `i${i}`
    if (seen.has(k)) k = `${k}#${i}`
    seen.add(k)
    return k
  })
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

export function SessionScreen({
  onToggleSidebar,
  sidebarHidden
}: {
  /** split view only: toggles the sessions column; replaces Back there */
  onToggleSidebar?: () => void
  sidebarHidden?: boolean
} = {}): JSX.Element {
  const id = useApp((s) => s.openSessionId)!
  const session = useApp((s) => s.sessions.find((x) => x.id === id))
  const transcript = useApp((s) => s.transcripts[id])
  const loading = useApp((s) => s.transcriptLoading)
  const stale = useApp((s) => s.transcriptStale)
  const sendPrompt = useApp((s) => s.sendPrompt)
  const interrupt = useApp((s) => s.interrupt)
  const conn = useApp((s) => s.conn)
  const queued = useApp((s) => s.queues[id] ?? NO_QUEUE)
  const queueMessage = useApp((s) => s.queueMessage)
  const removeQueued = useApp((s) => s.removeQueued)
  const sendQueuedNow = useApp((s) => s.sendQueuedNow)
  const nav = useNav()
  const [draft, setDraft] = useState('')
  const attachments = useImageAttachments()
  const pendingImages = attachments.images
  const [infoOpen, setInfoOpen] = useState(false)
  const [view, setView] = useState<'chat' | 'diff'>('chat')
  const [nearBottom, setNearBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const itemCount = transcript?.items.length ?? 0
  const loadingOlder = useApp((s) => s.loadingOlder)
  const olderFailed = useApp((s) => s.olderFailed)
  const loadOlder = useApp((s) => s.loadOlder)
  const hasOlder = typeof transcript?.cursor === 'number'
  const keys = useMemo(() => itemKeys(transcript?.items ?? []), [transcript])
  const scrollHeightRef = useRef(0)
  const olderLoadsRef = useRef(0)

  // an older page landed above: hold what the reader was looking at in place
  useLayoutEffect(() => {
    const el = scrollRef.current
    const loads = transcript?.olderLoads ?? 0
    if (el && loads > olderLoadsRef.current) {
      el.scrollTop += el.scrollHeight - scrollHeightRef.current
    }
    olderLoadsRef.current = loads
    if (el) scrollHeightRef.current = el.scrollHeight
  })

  const scrollToBottom = (smooth = false): void => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // follow the stream only while the user is at the bottom — jumping them
  // mid-read on every delta is what the nearBottom check prevents
  const followLoadsRef = useRef(0)
  useEffect(() => {
    // growth at the TOP: nearBottom may predate a scroll whose event hasn't fired
    const loads = transcript?.olderLoads ?? 0
    const prepended = loads > followLoadsRef.current
    followLoadsRef.current = loads
    if (nearBottom && !prepended) scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount, transcript, loading])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
    // layout can change with no render (fonts, reflow): re-measure at the trigger
    scrollHeightRef.current = el.scrollHeight
    if (hasOlder && !loadingOlder && !olderFailed && conn === 'online' && el.scrollTop < LOAD_OLDER_PX) {
      void loadOlder()
    }
  }

  // Slack-style auto-grow: content height up to the CSS max-height cap. Keyed
  // on the draft (not onChange) so programmatic changes — the clear after
  // send — shrink it back too.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, view])

  // the textarea unmounting while focused (back-swipe, diff view) skips onBlur
  useEffect(() => () => document.documentElement.classList.remove('kb-composer'), [view])

  const running = session?.status === 'running' || session?.status === 'starting'
  // dismissed per QUESTION, so skipping one does not silence the next
  const [choicesDismissed, setChoicesDismissed] = useState<string | null>(null)
  const occurrences = useMemo(() => userOccurrences(transcript?.items ?? []), [transcript])
  const choices = useMemo(
    () => (running ? null : lastQuickQuestion(transcript?.items)),
    [transcript, running]
  )

  const hasDraft = draft.trim() !== '' || pendingImages.length > 0
  const send = (): void => {
    const text = draft.trim()
    if (!hasDraft) return
    const images = pendingImages
    setDraft('')
    attachments.clear()
    // mid-turn, a submit waits its turn instead of racing the live one
    if (running) {
      queueMessage(id, text, images.length ? images : undefined)
      return
    }
    void sendPrompt(text || IMAGE_ONLY_PROMPT, images.length ? images : undefined)
  }

  const scrollToTop = (): void => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="screen session-screen">
      {/* the status-bar zone is inside the webview (viewport-fit=cover) but
          outside the header — this strip restores iOS's tap-to-top there */}
      <button className="statusbar-tap" aria-hidden="true" tabIndex={-1} onClick={scrollToTop} />
      <header className="topbar" onClick={scrollToTop}>
        {onToggleSidebar ? (
          <button
            className={'btn btn-ghost back-btn' + (sidebarHidden ? '' : ' panel-toggle-on')}
            aria-label="Toggle sessions column"
            onClick={(e) => {
              e.stopPropagation()
              onToggleSidebar()
            }}
          >
            <Icon name="panel-left" size={19} />
          </button>
        ) : (
          <button
            className="btn btn-ghost back-btn"
            onClick={(e) => {
              e.stopPropagation()
              nav.back()
            }}
          >
            ‹ Back
          </button>
        )}
        <button className="topbar-title topbar-session topbar-title-btn" onClick={scrollToTop}>
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
        <button
          className="btn btn-ghost view-toggle"
          aria-label="Session info"
          onClick={(e) => {
            e.stopPropagation()
            setInfoOpen(true)
          }}
        >
          ⓘ
        </button>
        <span className={`status-dot status-${session?.status ?? 'idle'}`} />
      </header>
      {view === 'diff' ? (
        <DiffPanel sessionId={id} />
      ) : (
        <div className="transcript-wrap">
          <div className="transcript" ref={scrollRef} onScroll={onScroll}>
            {itemCount > 0 && stale && (
              <p className="stale-note">
                {conn === 'online'
                  ? 'Reloading this conversation…'
                  : 'Offline — showing the last known conversation.'}
              </p>
            )}
            {loading && itemCount === 0 && <TranscriptSkeleton />}
            {!loading && itemCount === 0 && conn !== 'online' && (
              <p className="empty-note">
                Your computer isn&apos;t reachable right now — this conversation loads the moment
                it reconnects.
              </p>
            )}
            {!loading && itemCount === 0 && conn === 'online' && stale && (
              <p className="empty-note">
                Couldn&apos;t load this conversation — retrying automatically.
              </p>
            )}
            {!loading && itemCount === 0 && conn === 'online' && !stale && (
              <p className="empty-note">
                Nothing recorded in this conversation yet. If it was driven outside hang4r, its
                history syncs in the next time the agent takes a turn.
              </p>
            )}
            {hasOlder && (
              <div className="older-loader">
                {loadingOlder ? (
                  <span className="older-loading">Loading earlier messages…</span>
                ) : (
                  <button
                    className="btn btn-ghost older-btn"
                    disabled={conn !== 'online'}
                    onClick={() => void loadOlder()}
                  >
                    {olderFailed ? 'Couldn’t load — try again' : 'Load earlier messages'}
                  </button>
                )}
              </div>
            )}
            {transcript?.items.map((item, i) => (
              <TranscriptItem
                key={keys[i]}
                item={item}
                sessionId={id}
                occurrenceFromEnd={occurrences.get(item)}
              />
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
        <div className="composer-extras">
          <TaskProgress transcript={transcript} />
          {choices && choices.question !== choicesDismissed && (
            <div className="quick-replies">
              <div className="quick-replies-head">
                <span className="quick-replies-title">{choices.question}</span>
                <button
                  className="quick-replies-skip"
                  onClick={() => setChoicesDismissed(choices.question)}
                >
                  Skip
                </button>
              </div>
              {choices.options.map((c) => (
                <button
                  key={c.value}
                  className="quick-reply"
                  disabled={conn !== 'online'}
                  onClick={() => void sendPrompt(c.value)}
                >
                  <span className="quick-reply-key">{c.value}</span>
                  <span className="quick-reply-text">{c.text}</span>
                </button>
              ))}
            </div>
          )}
          {queued.length > 0 && (
            <div className="queue-strip">
              <p className="queue-count">{queued.length} Queued</p>
              {queued.map((m) => (
                <div key={m.id} className="queue-row">
                  {m.images?.length ? (
                    <span className="queue-row-img" aria-label="has an image">
                      <Icon name="image" size={14} />
                    </span>
                  ) : null}
                  <span className="queue-row-text">{m.text || 'Image'}</span>
                  <button
                    className="queue-row-btn"
                    aria-label="Edit queued message"
                    onClick={() => {
                      setDraft(m.text)
                      if (m.images?.length) attachments.add(m.images)
                      removeQueued(id, m.id)
                      inputRef.current?.focus()
                    }}
                  >
                    <Icon name="pencil" size={15} />
                  </button>
                  <button
                    className="queue-row-btn"
                    aria-label="Send now"
                    disabled={conn !== 'online'}
                    onClick={() => void sendQueuedNow(id, m.id)}
                  >
                    <Icon name="arrow-up" size={15} />
                  </button>
                  <button
                    className="queue-row-btn queue-row-del"
                    aria-label="Remove from queue"
                    onClick={() => removeQueued(id, m.id)}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {view === 'chat' && (
        <footer className="composer">
          <AttachButton onPick={attachments.pick} />
          <div className="composer-main">
            <PendingImages images={pendingImages} onRemove={attachments.remove} />
            <textarea
            ref={inputRef}
            className="composer-input"
            placeholder={
              conn !== 'online'
                ? 'desktop offline'
                : running
                  ? 'Agent is working… queue a follow-up'
                  : 'Message the agent…'
            }
            disabled={conn !== 'online'}
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => {
              document.documentElement.classList.add('kb-composer')
              setTimeout(() => scrollToBottom(false), 250)
            }}
            onBlur={() => document.documentElement.classList.remove('kb-composer')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
            }}
          />
          </div>
          <div className="composer-actions">
            {running && (
              <button
                className="composer-btn composer-stop"
                aria-label="Stop"
                title="Stop"
                onClick={() => void interrupt()}
              >
                <span className="composer-btn-disc">
                  <Icon name="stop" size={18} />
                </span>
              </button>
            )}
            {(!running || hasDraft) && (
              <button
                className={'composer-btn ' + (running ? 'composer-queue' : 'composer-send')}
                aria-label={running ? 'Queue' : 'Send'}
                title={running ? 'Queue' : 'Send'}
                disabled={!hasDraft || conn !== 'online'}
                onClick={send}
              >
                <span className="composer-btn-disc">
                  <Icon name="arrow-up" size={20} />
                </span>
              </button>
            )}
          </div>
        </footer>
      )}
      {infoOpen && session && (
        <SessionInfoSheet session={session} transcript={transcript} onClose={() => setInfoOpen(false)} />
      )}
    </div>
  )
}
