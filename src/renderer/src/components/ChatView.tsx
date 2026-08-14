import { memo, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useHang4r, type TranscriptItem } from '../state/store'
import { subagentLabelForPermission } from './SubagentInspector'
import { MdCode, MdPre, mdComponents, openFileHref } from './MarkdownBlocks'

type BlockItem = Extract<TranscriptItem, { type: 'block' }>

/**
 * Cached per-session `components` for the assistant markdown. CRITICAL: react-
 * markdown reconciles by component identity, so a fresh inline `{ a, code }`
 * object every render remounts every `<a>`/`<code>` DOM node — which COLLAPSES
 * any text selection anchored inside one of them. Angel hit this: selecting
 * text inside a `code` span (inline or fenced) flashed selected for a frame
 * then cleared, so ⌘C copied nothing while the Add-to-chat popup (which grabs
 * the string at mouseup) still worked. Selecting a whole row survived because
 * its Range boundaries sit at the block level, not inside the remounted node.
 * These handlers only close over `sessionId` (store reads happen at click
 * time), so one stable object per session is safe and keeps selections intact
 * across the frequent re-renders (selection popup, focus, streaming).
 */
const chatMdComponentsCache = new Map<string, Components>()

function chatMdComponents(sessionId: string): Components {
  const cached = chatMdComponentsCache.get(sessionId)
  if (cached) return cached
  const made: Components = {
    // fenced code blocks get a hover copy button (Angel)
    pre: MdPre,
    // links open the inner browser pane, never the app window;
    // file:// under the workdir opens in the editor instead. Right-click →
    // "Copy link address" copies the real target (URL/path), not the rendered
    // text (Angel: a "[this form]" link should copy its URL).
    a: ({ href, children }) => {
      const open = (): void => {
        if (!href) return
        if (/^file:\/\//.test(href) && openFileHref(sessionId, href)) return
        useHang4r.getState().requestOpenUrl(sessionId, href)
      }
      return (
        <a
          href={href}
          title={href}
          onClick={(e) => {
            e.preventDefault()
            open()
          }}
          onContextMenu={(e) => {
            if (!href || href.startsWith('#')) return
            e.preventDefault()
            e.stopPropagation()
            const isUrl = /^https?:\/\//.test(href)
            const value = /^file:\/\//.test(href)
              ? decodeURIComponent(href.replace(/^file:\/\//, ''))
              : href
            useHang4r.getState().openContextMenu(e.clientX, e.clientY, [
              {
                label: isUrl ? 'Copy link address' : 'Copy path',
                onClick: () => void navigator.clipboard.writeText(value)
              },
              { label: isUrl ? 'Open in browser' : 'Open', onClick: open }
            ])
          }}
        >
          {children}
        </a>
      )
    },
    // inline code that looks like a file path → ⌘/alt-click opens it in
    // the editor (with :line support); plain URLs → inner browser
    code: ({ children, ...props }) => {
      // block code / ```mermaid → shared block renderer (diagrams, styling)
      const cn = (props as { className?: string }).className
      if (/language-/.test(cn ?? '') || String(children ?? '').includes('\n')) {
        return <MdCode className={cn}>{children}</MdCode>
      }
      const text = typeof children === 'string' ? children : undefined
      const fileLike = text && /^(?:\.{1,2}\/|\/)?[\w@~+-][\w.@~+-]*(?:\/[\w.@~+-]+)+(?::\d+(?::\d+)?)?$/.test(text) && text.includes('/')
      const urlLike = text && /^https?:\/\//.test(text)
      if (!fileLike && !urlLike) return <code {...props}>{children}</code>
      return (
        <code
          {...props}
          className="code-link"
          title={urlLike ? '⌘-click to open in browser' : '⌘-click to open in editor'}
          onClick={(e) => {
            if (!e.metaKey && !e.altKey) return
            if (urlLike) return useHang4r.getState().requestOpenUrl(sessionId, text)
            // same classification as tool-row paths: in-tree → editor, absolute
            // or ~home outside the worktree → preview overlay (never a blank tab)
            void openToolPath(sessionId, text)
          }}
          onContextMenu={(e) => {
            if (!text) return
            e.preventDefault()
            e.stopPropagation()
            useHang4r.getState().openContextMenu(e.clientX, e.clientY, [
              {
                label: urlLike ? 'Copy link address' : 'Copy path',
                onClick: () => void navigator.clipboard.writeText(text)
              },
              {
                label: urlLike ? 'Open in browser' : 'Open',
                onClick: () => {
                  if (urlLike) useHang4r.getState().requestOpenUrl(sessionId, text)
                  else void openToolPath(sessionId, text)
                }
              }
            ])
          }}
        >
          {children}
        </code>
      )
    }
  }
  chatMdComponentsCache.set(sessionId, made)
  return made
}

/** A render unit: either a raw transcript item or a grouped activity run. */
type RenderUnit =
  | { kind: 'item'; item: TranscriptItem; index: number }
  | { kind: 'activity'; items: BlockItem[]; index: number; durationMs?: number }

/**
 * Cursor-style conversation: a centered column; user message cards; agent
 * prose; consecutive tool/thinking work collapsed into a "Worked for Ns"
 * activity group with compact one-line tool rows.
 *
 * MEMOIZED: the composer's `draft` lives in the store, so every keystroke
 * re-renders the parent SessionTile. Without memo this re-rendered the ENTIRE
 * transcript on each keystroke — perceptible typing lag in long conversations
 * (Angel). Props are referentially stable while typing (items is the store ref,
 * the rest are primitives/refs), so memo skips those re-renders.
 */
function ChatViewImpl({
  items,
  sessionId,
  running,
  scrollRef: externalScrollRef,
  findOpen
}: {
  items: TranscriptItem[]
  sessionId: string
  running: boolean
  /** let the parent tile reach into the scroll container (find bar, etc) */
  scrollRef?: RefObject<HTMLDivElement | null>
  /** while the find bar is open, don't fight the user's scroll position */
  findOpen?: boolean
}): JSX.Element {
  const internalScrollRef = useRef<HTMLDivElement>(null)
  const scrollRef = externalScrollRef ?? internalScrollRef
  const pinnedToBottom = useRef(true)
  // suppress the button toggle while WE animate the scroll, so it doesn't flicker
  // back on the intermediate onScroll events until the smooth scroll arrives
  const programmaticScroll = useRef(false)
  // show a "jump to latest" button once the user has scrolled up far enough that
  // the newest messages are off-screen (Angel: scrolling back down in a long
  // conversation is a chore — and new messages arriving while you're up there)
  const [showJump, setShowJump] = useState(false)

  const refreshJump = (el: HTMLDivElement): void => {
    if (programmaticScroll.current) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowJump((prev) => (prev === fromBottom > 240 ? prev : fromBottom > 240))
  }

  const scrollToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedToBottom.current = true
    programmaticScroll.current = true
    setShowJump(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (pinnedToBottom.current && !findOpen) el.scrollTop = el.scrollHeight
    refreshJump(el) // new content can push the newest messages off-screen
  }, [items, findOpen, scrollRef])

  // subagent-notes are Subagents-thread fuel, not conversation content — and
  // subagent-ATTRIBUTED blocks/tool rows stream in the Subagents panel, not
  // here (Angel, Jul 17: inline they drown the conversation; the Task card +
  // its result summary is the conversation-level record, ⤷ View thread has
  // the full stream)
  const visibleItems = useMemo(
    () =>
      items.filter(
        (i) => i.type !== 'subagent-note' && !(i.type === 'block' && i.parentToolUseId)
      ),
    [items]
  )
  const units = useMemo(() => groupActivity(visibleItems), [visibleItems])

  // per user message: how many identical user messages come AFTER it — the
  // stable "occurrence from the end" key the rewind flow matches on
  const userOccurrences = useMemo(() => {
    const map = new Map<TranscriptItem, number>()
    const seenAfter = new Map<string, number>()
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.type !== 'user') continue
      const key = it.text.trim()
      map.set(it, seenAfter.get(key) ?? 0)
      seenAfter.set(key, (seenAfter.get(key) ?? 0) + 1)
    }
    return map
  }, [items])

  return (
    <div
      className="chat-scroll"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget
        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
        pinnedToBottom.current = fromBottom < 80
        if (programmaticScroll.current && fromBottom < 80) programmaticScroll.current = false
        refreshJump(el)
      }}
    >
      <div className="chat-col">
        {/* Each unit is wrapped so `content-visibility: auto` (see .chat-unit)
            lets the browser skip layout/paint of off-screen messages — a
            20k-event transcript that pegged the renderer now renders only
            what's on screen. The DOM stays intact, so ⌘F find, scroll height,
            and jump-to-latest are unaffected. */}
        {units.map((u, i) => {
          if (u.kind === 'activity') {
            const isTail = i === units.length - 1
            return (
              <div className="chat-unit" key={`act-${u.index}`}>
                <ActivityGroup
                  items={u.items}
                  durationMs={u.durationMs}
                  defaultOpen={isTail && running}
                  sessionId={sessionId}
                />
              </div>
            )
          }
          return (
            <div className="chat-unit" key={unitKey(u.item, u.index)}>
              <TranscriptItemView
                item={u.item}
                sessionId={sessionId}
                userOccurrence={u.item.type === 'user' ? userOccurrences.get(u.item) : undefined}
                subagentLabel={
                  u.item.type === 'permission' ? subagentLabelForPermission(items, u.item) : null
                }
              />
            </div>
          )
        })}
        {running && <div className="chat-working">Working…</div>}
      </div>
      {showJump && (
        <button
          className="chat-jump-bottom"
          title="Jump to latest"
          aria-label="Jump to latest messages"
          onClick={scrollToBottom}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 3v9M4.5 8.5L8 12l3.5-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}

/** Memoized so a composer keystroke (store `draft` change → SessionTile re-render)
 *  doesn't re-render the whole transcript — the typing-lag fix. */
export const ChatView = memo(ChatViewImpl)

/** Fold consecutive non-text blocks (tools, thinking) into activity groups. */
function groupActivity(items: TranscriptItem[]): RenderUnit[] {
  const units: RenderUnit[] = []
  let current: BlockItem[] | null = null
  items.forEach((item, index) => {
    const isActivity =
      item.type === 'block' && (item.blockType === 'tool_use' || item.blockType === 'thinking')
    if (isActivity) {
      if (!current) {
        current = []
        units.push({ kind: 'activity', items: current, index })
      }
      current.push(item as BlockItem)
      return
    }
    // a completed turn's duration annotates the preceding activity group
    if (item.type === 'turn-info' && !item.isError && current) {
      const last = units[units.length - 1]
      if (last.kind === 'activity') last.durationMs = item.durationMs
    }
    current = null
    units.push({ kind: 'item', item, index })
  })
  return units
}

function unitKey(item: TranscriptItem, i: number): string {
  return item.type === 'block' ? item.key : `${item.type}-${i}`
}

function ActivityGroup({
  items,
  durationMs,
  defaultOpen,
  sessionId
}: {
  items: BlockItem[]
  durationMs?: number
  defaultOpen: boolean
  sessionId: string
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (defaultOpen) setOpen(true)
  }, [defaultOpen])

  const toolCount = items.filter((i) => i.blockType === 'tool_use').length
  const label = durationMs
    ? `Worked for ${(durationMs / 1000).toFixed(0)}s`
    : defaultOpen
      ? 'Working'
      : 'Worked'

  return (
    <div className="activity-group">
      <button className="activity-header" onClick={() => setOpen(!open)}>
        <span className="activity-caret">{open ? '▾' : '▸'}</span>
        <span>{label}</span>
        {toolCount > 0 && <span className="activity-count">{toolCount} steps</span>}
      </button>
      {open && (
        <div className="activity-body">
          {groupRuns(items).map((run) =>
            run.length === 1 ? (
              run[0].blockType === 'thinking' ? (
                <ThinkingBlock key={run[0].key} text={run[0].text} />
              ) : (
                <CompactToolRow key={run[0].key} item={run[0]} sessionId={sessionId} />
              )
            ) : (
              <CommandRunRow key={run[0].key} items={run} sessionId={sessionId} />
            )
          )}
        </div>
      )}
    </div>
  )
}

/** consecutive same-tool command calls collapse into one "Run a, b, c" row */
function groupRuns(items: BlockItem[]): BlockItem[][] {
  const runs: BlockItem[][] = []
  for (const item of items) {
    const prev = runs[runs.length - 1]
    if (
      prev &&
      item.blockType === 'tool_use' &&
      prev[0].blockType === 'tool_use' &&
      prev[0].toolName === item.toolName &&
      item.toolName === 'Bash' &&
      !item.parentToolUseId === !prev[0].parentToolUseId
    ) {
      prev.push(item)
    } else {
      runs.push([item])
    }
  }
  return runs
}

/** Cursor-style grouped commands: "Run gh api, base64, grep, sed". */
function CommandRunRow({
  items,
  sessionId
}: {
  items: BlockItem[]
  sessionId: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const anyPending = items.some((i) => !i.final || i.toolResult === undefined)
  const anyError = items.some((i) => i.toolResultError)
  const status = anyPending ? '◌' : anyError ? '✕' : '✓'
  const names = items
    .map((i) => firstWordOfCommand(i.toolInput))
    .filter(Boolean)
    .slice(0, 5)
  return (
    <div className="tool-row">
      <button className="tool-row-main" onClick={() => setOpen(!open)}>
        <span className={'tool-status' + (anyPending ? ' tool-status-spin' : '')}>{status}</span>
        <span className="tool-name">Run</span>
        <span className="tool-summary">
          {names.join(', ')}
          {items.length > names.length ? ` +${items.length - names.length}` : ''}
        </span>
      </button>
      {open && (
        <div className="command-run-list">
          {items.map((item) => (
            <CompactToolRow key={item.key} item={item} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  )
}

function firstWordOfCommand(input: unknown): string {
  if (input && typeof input === 'object') {
    const cmd = (input as Record<string, unknown>).command
    if (typeof cmd === 'string') return cmd.trim().split(/\s+/)[0] ?? ''
  }
  return ''
}

function TranscriptItemView({
  item,
  sessionId,
  userOccurrence,
  subagentLabel
}: {
  item: TranscriptItem
  sessionId: string
  userOccurrence?: number
  subagentLabel?: string | null
}): JSX.Element | null {
  if (item.type === 'user') {
    return <UserMessageCard item={item} sessionId={sessionId} occurrenceFromEnd={userOccurrence ?? 0} />
  }
  if (item.type === 'permission') {
    return <PermissionCard item={item} sessionId={sessionId} subagentLabel={subagentLabel} />
  }
  if (item.type === 'question') {
    return <QuestionCard item={item} sessionId={sessionId} />
  }
  if (item.type === 'plan') {
    return <PlanCard entries={item.entries} />
  }
  if (item.type === 'turn-info') {
    if (!item.isError) {
      return (
        <div
          className="turn-info"
          title={
            item.costUsd
              ? "This session's running total — the API-equivalent cost of just this session (not other open sessions). It's what these turns would cost through the pay-per-token API; on your Claude subscription it's covered by your plan, not billed on top."
              : undefined
          }
        >
          {item.durationMs ? `done · ${(item.durationMs / 1000).toFixed(1)}s` : 'done'}
          {item.costUsd ? ` · session $${item.costUsd.toFixed(2)}` : ''}
        </div>
      )
    }
    return <div className="turn-info turn-info-error">⚠ {item.errorMessage ?? 'turn failed'}</div>
  }
  if (item.type === 'subagent-note') return null // Subagents-thread fuel only
  // worktree setup-script lifecycle — stays in the transcript so a failed
  // `npm install` is visible after the fact (lastError gets wiped by the next turn)
  if (item.type === 'setup-note') {
    return (
      <div className={'setup-note' + (item.isError ? ' setup-note-error' : '')}>
        {item.isError ? '⚠ ' : '⚙ '}
        {item.text}
      </div>
    )
  }
  // a turn taken in an external interactive CLI (/remote-control), re-synced in
  if (item.type === 'external-turn') {
    return (
      <div className={'msg-external ' + (item.role === 'user' ? 'msg-user-card' : 'msg-assistant')}>
        <span
          className="external-chip"
          title="This turn happened in an interactive Claude CLI on this conversation (e.g. /remote-control) and was synced back into hang4r"
        >
          ⇄ interactive CLI
        </span>
        {item.role === 'assistant' ? (
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents(sessionId)}>{item.text}</Markdown>
        ) : (
          <div className="msg-user-text">{item.text}</div>
        )}
      </div>
    )
  }
  // assistant text block
  if (item.blockType !== 'text' || !item.text) return null
  return (
    <div className={'msg-assistant' + (item.parentToolUseId ? ' msg-subagent' : '')}>
      <Markdown remarkPlugins={[remarkGfm]} components={chatMdComponents(sessionId)}>
        {item.text}
      </Markdown>
    </div>
  )
}

/**
 * A sent user message. Hover shows an Edit affordance whose behavior is HONEST
 * per backend: Claude forks (`--resume-session-at`) and Codex rolls back
 * (`thread/rollback`) — both truncate, discarding the later messages; Cursor has
 * no fork/truncate primitive, so editing there resends as a NEW turn (append)
 * and the earlier messages stay. The copy tells the truth about which happens.
 */
function UserMessageCard({
  item,
  sessionId,
  occurrenceFromEnd
}: {
  item: Extract<TranscriptItem, { type: 'user' }>
  sessionId: string
  occurrenceFromEnd: number
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const backend = useHang4r((s) => s.sessions.find((x) => x.id === sessionId)?.backend)
  const openLightbox = useHang4r((s) => s.openLightbox)
  const requestOpenFile = useHang4r((s) => s.requestOpenFile)
  // Cursor can only append; Claude/Codex truly discard the later messages. Keep
  // every string truthful about which one this backend does.
  const appendOnly = backend === 'cursor'
  const copy = appendOnly
    ? {
        editTitle: 'Edit & resend as a new turn — Cursor can’t rewind history, so earlier messages stay',
        hint: 'Cursor can’t rewind history — this asks again as a new turn; the earlier messages stay',
        send: 'Resend as new turn',
        busy: 'Sending…',
        imagesTitle: 'Images aren’t re-sent — Cursor’s headless mode can’t take image input'
      }
    : {
        editTitle: 'Edit & restart the conversation from this message',
        hint: 'restarts the conversation from here — later messages are discarded',
        send: 'Send from here',
        busy: 'Rewinding…',
        imagesTitle: 'Attached images are kept and re-sent with the edit'
      }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      await useHang4r.getState().rewindAndResend(sessionId, item.text, occurrenceFromEnd, text)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="msg-user-card msg-user-editing">
        {item.images && item.images.length > 0 && (
          <div className="msg-user-images" title={copy.imagesTitle}>
            {item.images.map((img, i) => {
              const src = `data:${img.mediaType};base64,${img.base64}`
              return (
                <img
                  key={i}
                  className="msg-user-image"
                  src={src}
                  alt={`attached image ${i + 1}`}
                  onClick={() => openLightbox(src, 'image', `attached image ${i + 1}`)}
                />
              )
            })}
          </div>
        )}
        <textarea
          className="msg-edit-input"
          value={draft}
          autoFocus
          rows={Math.min(10, Math.max(2, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
        />
        {error && <div className="msg-edit-error">⚠ {error}</div>}
        <div className="msg-edit-actions">
          <span className="msg-edit-hint">{copy.hint}</span>
          <button className="ghost-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button className="msg-edit-send" disabled={busy || !draft.trim()} onClick={() => void send()}>
            {busy ? copy.busy : copy.send}
          </button>
        </div>
      </div>
    )
  }

  const isResumeMarker = /^— resumed: \d+ earlier message/.test(item.text)
  return (
    <div className="msg-user-card">
      {!isResumeMarker && (
        <button
          className="msg-edit-btn"
          title={copy.editTitle}
          onClick={() => {
            setDraft(item.text)
            setEditing(true)
          }}
        >
          ✎
        </button>
      )}
      {item.images && item.images.length > 0 && (
        <div className="msg-user-images">
          {item.images.map((img, i) => {
            const src = `data:${img.mediaType};base64,${img.base64}`
            return (
              <img
                key={i}
                className="msg-user-image"
                src={src}
                alt={`attached image ${i + 1}`}
                onClick={() => openLightbox(src, 'image', `attached image ${i + 1}`)}
              />
            )
          })}
        </div>
      )}
      {item.files && item.files.length > 0 && (
        <div className="msg-user-files">
          {item.files.map((f, i) => (
            <button
              key={i}
              className="msg-user-file"
              title={f.path ? `Open ${f.name}` : f.name}
              disabled={!f.path}
              onClick={() => f.path && requestOpenFile(sessionId, f.path)}
            >
              <span className="msg-user-file-badge">{fileBadge(f.name)}</span>
              <span className="msg-user-file-name">{f.name}</span>
            </button>
          ))}
        </div>
      )}
      {/* a message with a ``` code fence OR a > blockquote renders as markdown
          (fenced block → real code block; a quoted "add to chat" selection → a
          wrapped blockquote, not a horizontally-scrolling code box); plain prose
          stays verbatim so nothing else gets reinterpreted (Angel). */}
      {item.text &&
        (/(^|\n)(```|>)/.test(item.text) ? (
          <div className="msg-user-md markdown-body">
            <Markdown remarkPlugins={[remarkGfm]} components={chatMdComponents(sessionId)}>
              {item.text}
            </Markdown>
          </div>
        ) : (
          item.text
        ))}
    </div>
  )
}

/** short uppercase extension badge for a file card (PDF, XLSX, MD, …) */
function fileBadge(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toUpperCase()
  return ext && ext !== name.toUpperCase() ? ext.slice(0, 4) : 'FILE'
}

/** One-line tool row, Cursor-style: status · name · summary, expandable. */
/** the file a file-op tool targets (Read/Write/Edit/MultiEdit/NotebookEdit) — for
 *  the clickable "open this file" affordance. null for non-file tools. */
function toolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const p = (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).notebook_path
  return typeof p === 'string' && p.length > 0 ? p : null
}

/** Resolve a relative path referenced in the conversation to a REAL in-tree file:
 *  its exact path if present, else the unique basename match (a bare
 *  "settings.local.json" that lives in .claude/), else null. Lets a clicked path
 *  open the RIGHT, loadable editor tab instead of a blank one — a blank tab that
 *  fails to read re-opens the preview on every panel switch (Angel's loop). */
async function resolveInTree(sessionId: string, relPath: string): Promise<string | null> {
  const files = await window.hang4r.listAllFiles(sessionId, true).catch(() => [] as string[])
  if (files.includes(relPath)) return relPath
  const base = relPath.split('/').pop()
  const matches = files.filter((f) => f.split('/').pop() === base)
  return matches.length === 1 ? matches[0] : null
}

/**
 * Open a path referenced in a tool call or in prose. Under the session's worktree
 * → an editor tab (with :line). Absolute OR home-relative (~/…) AND outside the
 * worktree (e.g. /tmp files or ~/.claude/… a run wrote elsewhere) → a preview
 * overlay (image/pdf render, text shows), since the editor is sandboxed to the
 * workspace. Relative → resolved to its real in-tree file for an editor tab, or a
 * one-time preview if it can't be resolved.
 */
async function openToolPath(sessionId: string, rawPath: string): Promise<void> {
  const store = useHang4r.getState()
  const lm = /:(\d+)(?::\d+)?$/.exec(rawPath)
  const path = (lm ? rawPath.slice(0, lm.index) : rawPath).replace(/^\.\//, '')
  const line = lm ? Number(lm[1]) : undefined
  const cwd = store.sessions.find((s) => s.id === sessionId)?.cwd
  // Everything opens as a real EDITOR TAB now — in-tree files by their relative
  // path, out-of-tree files by their ABSOLUTE path (the editor reads/writes it
  // directly), and a path that can't be resolved opens a tab showing a quiet
  // "couldn't open" notice. No read-only modal for opening a file (Angel).
  if (cwd && path.startsWith(cwd + '/')) {
    store.requestOpenFile(sessionId, path.slice(cwd.length + 1), line)
  } else if (path.startsWith('/') || path.startsWith('~/') || path === '~') {
    store.requestOpenFile(sessionId, path, line) // absolute / ~home → editable tab
  } else {
    // relative → open the real in-tree file if we can resolve it, else the raw
    // path (the editor shows the inline notice rather than looping on a modal)
    const resolved = await resolveInTree(sessionId, path)
    store.requestOpenFile(sessionId, resolved ?? path, line)
  }
}

function CompactToolRow({
  item,
  sessionId
}: {
  item: BlockItem
  sessionId: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const pending = item.final && item.toolResult === undefined
  const status = !item.final || pending ? '◌' : item.toolResultError ? '✕' : '✓'
  // Claude's TodoWrite renders as a live plan card instead of a tool row
  if (item.toolName === 'TodoWrite') {
    const todos =
      ((item.toolInput as { todos?: { content: string; status: string }[] })?.todos ?? []).map(
        (t) => ({
          step: t.content,
          status:
            t.status === 'completed'
              ? ('completed' as const)
              : t.status === 'in_progress'
                ? ('inProgress' as const)
                : ('pending' as const)
        })
      )
    return <PlanCard entries={todos} />
  }
  // top-level agent runs get a jump-to-thread action (the Subagents panel is
  // where their live activity streams — don't make the user hunt for it)
  const isAgentRun =
    (item.toolName === 'Task' || item.toolName === 'Agent') && !item.parentToolUseId
  return (
    <div className={'tool-row' + (item.toolResultError ? ' tool-row-error' : '')} data-session={sessionId}>
      <div className="tool-row-line">
        <button className="tool-row-main" onClick={() => setOpen(!open)}>
          <span className={'tool-status' + (!item.final || pending ? ' tool-status-spin' : '')}>
            {status}
          </span>
          <span className="tool-name">{item.toolName ?? 'tool'}</span>
          {(() => {
            const fp = toolFilePath(item.toolInput)
            const summary = summarizeInput(item.toolInput)
            return fp ? (
              <span
                className="tool-summary tool-path-link"
                title={`Open ${fp}`}
                onClick={(e) => {
                  e.stopPropagation() // open the file, don't toggle the row
                  void openToolPath(sessionId, fp)
                }}
              >
                {summary}
              </span>
            ) : (
              <span className="tool-summary">{summary}</span>
            )
          })()}
          {item.parentToolUseId && <span className="subagent-badge">subagent</span>}
        </button>
        {isAgentRun && (
          <button
            className="tool-row-action"
            title="Follow this agent's thread in the Subagents panel"
            onClick={() => useHang4r.getState().openSubagents(sessionId)}
          >
            ⤷ View thread
          </button>
        )}
      </div>
      {open && (
        <div className="tool-row-detail">
          <div className="tool-section-label">input</div>
          <pre>{pretty(item.toolInput ?? item.text)}</pre>
          {item.toolResult !== undefined && (
            <>
              <div className="tool-section-label">result</div>
              <pre>{pretty(item.toolResult)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Live plan/todo card (Codex turn/plan/updated · Claude TodoWrite). */
function PlanCard({
  entries
}: {
  entries: { step: string; status: 'pending' | 'inProgress' | 'completed' }[]
}): JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div className="plan-card">
      <div className="plan-title">Plan</div>
      {entries.map((e, i) => (
        <div key={i} className={`plan-entry plan-${e.status}`}>
          <span className="plan-mark">
            {e.status === 'completed' ? '✓' : e.status === 'inProgress' ? '◐' : '○'}
          </span>
          <span>{e.step}</span>
        </div>
      ))}
    </div>
  )
}

/** Inline approval prompt: the agent is waiting on a decision. */
function PermissionCard({
  item,
  sessionId,
  subagentLabel
}: {
  item: Extract<TranscriptItem, { type: 'permission' }>
  sessionId: string
  subagentLabel?: string | null
}): JSX.Element {
  const respondPermission = useHang4r((s) => s.respondPermission)
  const decided = item.decision !== undefined
  return (
    <div className={'permission-card' + (decided ? ' permission-card-decided' : '')}>
      <div className="permission-header">
        {subagentLabel && (
          <span className="permission-subagent" title={`Requested by subagent: ${subagentLabel}`}>
            ⤷ {subagentLabel.slice(0, 32)}
          </span>
        )}
        <span className="permission-tool">{item.tool}</span>
        <span className="permission-summary">{item.summary}</span>
        {!decided && (
          <span className="permission-actions">
            {item.options.map((opt, i) => {
              const allowish = opt.startsWith('accept') || opt.startsWith('allow')
              // only the FIRST allow option is loud; sibling allow variants
              // (allow-for-session etc) are quiet outlines — two solid purple
              // blocks side by side read as noise (Angel's screenshot)
              const cls = !allowish
                ? 'ghost-btn perm-btn'
                : item.options.findIndex((o) => o.startsWith('accept') || o.startsWith('allow')) === i
                  ? 'primary-btn perm-btn'
                  : 'perm-btn perm-btn-secondary'
              return (
                <button
                  key={opt}
                  className={cls}
                  onClick={() => void respondPermission(sessionId, item.requestId, opt)}
                >
                  {PERMISSION_LABELS[opt] ?? opt}
                </button>
              )
            })}
          </span>
        )}
        {decided && <span className="permission-decision">→ {item.decision}</span>}
      </div>
      {item.detail && <div className="permission-detail">{item.detail}</div>}
    </div>
  )
}

/**
 * Inline answerable question (Claude AskUserQuestion): the agent is waiting on
 * the user to PICK an option (not allow/deny). Single-choice single-question
 * submits on click (like the permission card); anything multi (multi-select, or
 * more than one question) toggles a selection and submits with a button.
 */
function QuestionCard({
  item,
  sessionId
}: {
  item: Extract<TranscriptItem, { type: 'question' }>
  sessionId: string
}): JSX.Element {
  const respondQuestion = useHang4r((s) => s.respondQuestion)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const answered = item.answers !== undefined
  const cancelled = !!item.cancelled
  const live = !answered && !cancelled

  const oneShot = item.questions.length === 1 && !item.questions[0].allowMultiple

  const toggle = (qId: string, optId: string, allowMultiple: boolean): void => {
    setSelected((s) => {
      const cur = s[qId] ?? []
      if (allowMultiple) {
        return { ...s, [qId]: cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId] }
      }
      return { ...s, [qId]: [optId] }
    })
  }

  const submit = (answers: { questionId: string; optionIds: string[] }[]): void => {
    void respondQuestion(sessionId, item.requestId, answers)
  }

  const allAnswered = item.questions.every((q) => (selected[q.id]?.length ?? 0) > 0)

  // once answered, render the chosen labels; keep the questions visible for context
  const chosenLabels = (qId: string): string => {
    const q = item.questions.find((x) => x.id === qId)
    const ids = item.answers?.find((a) => a.questionId === qId)?.optionIds ?? []
    return ids
      .map((id) => q?.options.find((o) => o.id === id)?.label ?? id)
      .join(', ')
  }

  return (
    <div className={'question-card' + (live ? '' : ' question-card-decided')}>
      <div className="question-header">
        <span className="question-tag">Question</span>
        {item.title && <span className="question-title">{item.title}</span>}
        {cancelled && <span className="question-decision">→ cancelled</span>}
      </div>
      {item.questions.map((q) => (
        <div className="question-block" key={q.id}>
          <div className="question-prompt">{q.prompt}</div>
          {live ? (
            <div className="question-options">
              {q.options.map((opt) => {
                const isSel = (selected[q.id] ?? []).includes(opt.id)
                if (oneShot) {
                  return (
                    <button
                      key={opt.id}
                      className="perm-btn primary-btn question-option"
                      onClick={() => submit([{ questionId: q.id, optionIds: [opt.id] }])}
                    >
                      {opt.label}
                    </button>
                  )
                }
                return (
                  <button
                    key={opt.id}
                    className={
                      'perm-btn question-option' +
                      (isSel ? ' question-option-selected' : ' perm-btn-secondary')
                    }
                    onClick={() => toggle(q.id, opt.id, !!q.allowMultiple)}
                  >
                    {q.allowMultiple ? (isSel ? '☑ ' : '☐ ') : ''}
                    {opt.label}
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="question-answer">
              {answered ? `→ ${chosenLabels(q.id) || '(no answer)'}` : '→ cancelled'}
            </div>
          )}
        </div>
      ))}
      {live && !oneShot && (
        <div className="question-actions">
          <button
            className="primary-btn perm-btn"
            disabled={!allAnswered}
            onClick={() =>
              submit(
                item.questions.map((q) => ({ questionId: q.id, optionIds: selected[q.id] ?? [] }))
              )
            }
          >
            Submit answer
          </button>
        </div>
      )}
    </div>
  )
}

const PERMISSION_LABELS: Record<string, string> = {
  allow: 'Allow',
  accept: 'Allow',
  acceptForSession: 'Allow for session',
  allow_session: 'Allow for session',
  allow_always: 'Always allow',
  deny: 'Deny',
  decline: 'Deny'
}

function ThinkingBlock({ text }: { text: string }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="thinking-block">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} thinking
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  )
}

function summarizeInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const hint =
      obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.query ?? obj.url ?? obj.prompt ?? obj.description
    if (typeof hint === 'string') return hint.length > 80 ? hint.slice(0, 77) + '…' : hint
  }
  return ''
}

function pretty(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    const s = JSON.stringify(v, null, 2)
    return s.length > 4000 ? s.slice(0, 4000) + '\n… (truncated)' : s
  } catch {
    return String(v)
  }
}
