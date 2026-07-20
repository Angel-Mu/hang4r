import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent
} from 'react'
import { createPortal } from 'react-dom'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { BackendId, ModelChoice, PermissionMode } from '../../../shared/protocol'
import { useHang4r } from '../state/store'
import { resumeCliCommand } from '../resumeCli'
import { onForgetSession, onSeedSessionUi, persistSessionUi } from '../sessionUiMemos'
import { contextWindow } from '../contextWindow'
import { ChatView } from './ChatView'
import { ChatFindBar } from './ChatFindBar'
import { DiffView } from './DiffView'
import { TerminalPanel } from './TerminalPanel'
import { ProcessesPanel } from './ProcessesPanel'
import { FileBrowser } from './FileBrowser'
import { SubagentInspector } from './SubagentInspector'
import { BackgroundTasks } from './BackgroundTasks'
import { HooksTimeline } from './HooksTimeline'
import { EnvBrowser } from './EnvBrowser'
import { BrowserPane } from './BrowserPane'
import { AttachMenu } from './AttachMenu'
import { MentionMenu, useMentionResults } from './MentionMenu'
import { SlashMenu, slashResults, type SlashItem } from './SlashMenu'
import { ModelPicker } from './ModelPicker'
import { Icon } from './Icon'
import { CLAUDE_MODELS, FALLBACK_CODEX_MODELS, FALLBACK_CURSOR_MODELS } from '../modelChoices'

/** Context panel views shown SIDE-BY-SIDE with chat (Cursor's split), not tabs over it. */
// Search is NOT a tab — it lives inside the Files panel, Cursor-style
// (explorer ⇄ search mode toggle), per Angel's explicit feedback.
const CONTEXT_TABS = ['Files', 'Diff', 'Terminal', 'Processes', 'Browser', 'Subagents', 'Tasks', 'Hooks', 'Env'] as const
type ContextTab = (typeof CONTEXT_TABS)[number]

/** Open panel + last-open tab per session — a pane-count change reshapes the
 *  Workspace tree and remounts the tile (QA hunt #10), so these must live
 *  outside component state, same precedent as FileBrowser's layoutMemo. */
const contextTabMemo = new Map<string, ContextTab | null>()
const lastContextTabMemo = new Map<string, ContextTab>()
onForgetSession((sessionId) => {
  contextTabMemo.delete(sessionId)
  lastContextTabMemo.delete(sessionId)
})
// seed which panel was active from the persisted snapshot at startup, so a
// session reopens on its Files/Diff/Terminal/… panel after an app restart
onSeedSessionUi((sessionId, snap) => {
  // only fill an EMPTY memo — never clobber the live state of an open session
  if (snap.contextTab !== undefined && !contextTabMemo.has(sessionId)) {
    const t = snap.contextTab as ContextTab | null
    contextTabMemo.set(sessionId, t)
    if (t) lastContextTabMemo.set(sessionId, t)
  }
})

/** stable empty ref — returning a fresh [] from a zustand selector loops (React #185) */
const NO_ATTACHMENTS: { label: string; text: string }[] = []
const NO_QUEUE: import('../state/store').QueuedMessage[] = []

/** permission modes in the CLI's own Shift+Tab cycle order, with short labels */
const PERMISSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask (default)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' }
]

const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  default: 'Ask (default)',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass'
}

/** approximate context window per model family (tokens) */
/** read a Blob/File as base64 (no data: prefix) for image attachments */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/** rough slug used for the new-branch-name suggestion in the commit menu */
function slugish(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'session'
  )
}

function fmtTok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n)
}

/** Per-conversation usage: context-window bar + cumulative tokens + cost. */
function SessionUsage({
  sessionId,
  cost,
  model,
  backend,
  models
}: {
  sessionId: string
  cost: number
  model: string | null
  backend: BackendId
  models?: ModelChoice[]
}): JSX.Element | null {
  const usage = useHang4r((s) => s.sessionUsage[sessionId])
  if (!usage && cost === 0) return null
  const ctx = usage?.contextTokens ?? 0
  const max = usage?.contextWindowTokens ?? contextWindow(model, backend, models)
  const pct = max ? Math.min(100, Math.round((ctx / max) * 100)) : 0
  const cls = pct >= 90 ? 'ctx-bad' : pct >= 80 ? 'ctx-warn' : 'ctx-ok'
  return (
    <span
      className="session-usage"
      title={
        max
          ? `context ${ctx.toLocaleString()} / ${max.toLocaleString()} tokens` +
            (backend === 'cursor' ? ' (window read from the model name — Cursor docs publish no fixed number)' : '')
          : backend === 'cursor'
            ? `context ${ctx.toLocaleString()} tokens — Cursor doesn't report a context window for this model`
            : `context ${ctx.toLocaleString()} tokens`
      }
    >
      {ctx > 0 && max && (
        <span className={'ctx-meter ' + cls}>
          <span className="ctx-fill" style={{ width: pct + '%' }} />
          <span className="ctx-label">{pct}%</span>
        </span>
      )}
      {usage && (
        <span className="usage-toks">
          {fmtTok(usage.inputTokens)}↓ {fmtTok(usage.outputTokens)}↑
        </span>
      )}
      {cost > 0 && <span>${cost.toFixed(3)}</span>}
    </span>
  )
}

/** Cursor-style context-window gauge shown in the composer bar (a small ring). */
function ComposerContext({
  sessionId,
  model,
  backend,
  models,
  running
}: {
  sessionId: string
  model: string | null
  backend: BackendId
  models?: ModelChoice[]
  running: boolean
}): JSX.Element | null {
  const usage = useHang4r((s) => s.sessionUsage[sessionId])
  const raw = usage?.contextTokens ?? 0
  const ctx = Number.isFinite(raw) ? raw : 0
  // no data yet: show a "measuring" ring while the agent works (so the gauge is
  // always visibly present), otherwise render nothing on a fresh idle session
  if (ctx <= 0) {
    if (!running) return null
    return (
      <span className="composer-ctx ctx-ok composer-ctx-wait" title="Measuring context…">
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.2" />
        </svg>
        …
      </span>
    )
  }
  const max = usage?.contextWindowTokens ?? contextWindow(model, backend, models)
  if (!max) {
    return (
      <span
        className="composer-ctx ctx-ok"
        title={
          backend === 'cursor'
            ? `Context: ${ctx.toLocaleString()} tokens — Cursor doesn't report a context window for this model`
            : `Context: ${ctx.toLocaleString()} tokens`
        }
      >
        {fmtTok(ctx)}
      </span>
    )
  }
  const pct = Math.min(100, Math.round((ctx / max) * 100))
  const cls = pct >= 90 ? 'ctx-bad' : pct >= 80 ? 'ctx-warn' : 'ctx-ok'
  const r = 6
  const circ = 2 * Math.PI * r
  return (
    <span
      className={'composer-ctx ' + cls}
      title={
        `Context: ${ctx.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)` +
        (backend === 'cursor' ? ' (window read from the model name — Cursor docs publish no fixed number)' : '')
      }
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct / 100)}
          transform="rotate(-90 8 8)"
        />
      </svg>
      {pct}%
    </span>
  )
}

const CLAUDE_PICKER_MODELS = CLAUDE_MODELS.map((m) =>
  m.value === '' ? { ...m, label: 'Default' } : m
)
const CODEX_PICKER_FALLBACK = FALLBACK_CODEX_MODELS.map((m) =>
  m.value === '' ? { ...m, label: 'Default' } : m
)
const CURSOR_PICKER_FALLBACK = FALLBACK_CURSOR_MODELS.map((m) =>
  m.value === '' ? { ...m, label: 'Default' } : m
)

export function SessionTile({ sessionId }: { sessionId: string }): JSX.Element | null {
  const session = useHang4r((s) => s.sessions.find((x) => x.id === sessionId))
  const workspace = useHang4r((s) => s.projects.find((p) => p.id === session?.projectId))
  const transcript = useHang4r((s) => s.transcripts[sessionId])
  const focused = useHang4r((s) => s.focusedSessionId === sessionId)
  const expanded = useHang4r((s) => s.expandedSessionId === sessionId)
  const focusSession = useHang4r((s) => s.focusSession)
  const openReviewFor = useHang4r((s) => s.openReviewFor)
  const toggleExpand = useHang4r((s) => s.toggleExpand)
  const closeTile = useHang4r((s) => s.closeTile)
  const sendPrompt = useHang4r((s) => s.sendPrompt)
  const interrupt = useHang4r((s) => s.interrupt)
  const duplicateSession = useHang4r((s) => s.duplicateSession)
  const retrySession = useHang4r((s) => s.retrySession)
  const addAttachment = useHang4r((s) => s.addAttachment)
  const removeAttachment = useHang4r((s) => s.removeAttachment)
  const attachments = useHang4r((s) => s.attachments[sessionId] ?? NO_ATTACHMENTS)
  const queued = useHang4r((s) => s.messageQueue[sessionId] ?? NO_QUEUE)
  const queueMessage = useHang4r((s) => s.queueMessage)
  const removeQueuedMessage = useHang4r((s) => s.removeQueuedMessage)
  const sendQueuedNow = useHang4r((s) => s.sendQueuedNow)
  const draft = useHang4r((s) => s.drafts[sessionId] ?? '')
  const setDraft = useHang4r((s) => s.setDraft)
  const renameSession = useHang4r((s) => s.renameSession)
  const setSessionPermissionMode = useHang4r((s) => s.setSessionPermissionMode)

  /** which context panel is open next to chat (null = chat full width).
   *  A new agent opens chat-only (Cursor) — the conversation is all that shows
   *  until you open a panel (or a ⌘P/⌘⇧F/diff action surfaces one).
   *  Memoized per session: pane-count changes reshape the Workspace tree and
   *  remount the whole tile (QA hunt #10) — the open panel must survive that. */
  const [contextTab, setContextTab] = useState<ContextTab | null>(
    () => contextTabMemo.get(sessionId) ?? null
  )
  useEffect(() => {
    contextTabMemo.set(sessionId, contextTab)
    // persist so the session reopens on this panel after an app restart
    void persistSessionUi(sessionId, { contextTab })
  }, [sessionId, contextTab])
  // remembers the last-open tab across a ⌥⌘B / rail-expand cycle so
  // reopening the panel restores where you were, not always Files
  const lastContextTabRef = useRef<ContextTab>(lastContextTabMemo.get(sessionId) ?? 'Files')
  useEffect(() => {
    if (contextTab) {
      lastContextTabRef.current = contextTab
      lastContextTabMemo.set(sessionId, contextTab)
    }
  }, [sessionId, contextTab])
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [codexModels, setCodexModels] = useState(CODEX_PICKER_FALLBACK)
  const [cursorModels, setCursorModels] = useState(CURSOR_PICKER_FALLBACK)
  const [attachOpen, setAttachOpen] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [commitMenuOpen, setCommitMenuOpen] = useState(false)
  const [commitMenuPos, setCommitMenuPos] = useState<{ right: number; bottom: number } | null>(null)
  const commitSplitRef = useRef<HTMLDivElement>(null)
  // inline @-mention file picker
  const [allFiles, setAllFiles] = useState<string[]>([])
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionActive, setMentionActive] = useState(0)
  // inline / slash-command menu
  const init = useHang4r((s) => s.sessionInit[sessionId])
  const [slash, setSlash] = useState<{ query: string; start: number } | null>(null)
  const [slashActive, setSlashActive] = useState(0)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [changedCount, setChangedCount] = useState(0)
  // Claude reasoning-effort (real --effort flag: low|medium|high|xhigh|max)
  const [effort, setEffortState] = useState('')
  useEffect(() => {
    void window.hang4r.getSessionEffort(sessionId).then((v) => setEffortState(v ?? ''))
  }, [sessionId])
  // the REAL branch for the header chip — the tile used to fabricate
  // `hang4r/<slug>` from the title, which stopped matching reality
  const [wtBranch, setWtBranch] = useState<string | null>(null)
  useEffect(() => {
    if (session?.environment !== 'worktree') return
    let stale = false
    void window.hang4r.currentBranch(sessionId).then((b) => !stale && setWtBranch(b))
    return () => {
      stale = true
    }
  }, [sessionId, session?.environment, session?.cwd])
  useEffect(() => {
    if (session?.backend !== 'codex') return
    void window.hang4r
      .listCodexModels()
      .then((choices) =>
        setCodexModels(choices.map((m) => (m.value === '' ? { ...m, label: 'Default' } : m)))
      )
      .catch(() => setCodexModels(CODEX_PICKER_FALLBACK))
  }, [session?.backend])
  useEffect(() => {
    if (session?.backend !== 'cursor') return
    void window.hang4r
      .listCursorModels()
      .then((choices) =>
        setCursorModels(choices.map((m) => (m.value === '' ? { ...m, label: 'Default' } : m)))
      )
      .catch(() => setCursorModels(CURSOR_PICKER_FALLBACK))
  }, [session?.backend])
  /** floating "Add to chat" for any selected text inside the tile */
  const [selPopup, setSelPopup] = useState<{ text: string; x: number; y: number } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // ⌘F "find in conversation" (round 12 ③) — App.tsx's global handler finds
  // the focused tile's .chat-scroll and dispatches this event on it; a second
  // ⌘F while already open just re-focuses/selects the query (findToken bump).
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findToken, setFindToken] = useState(0)
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const onToggle = (): void => {
      setFindOpen(true)
      setFindToken((t) => t + 1)
    }
    el.addEventListener('hang4r-find-toggle', onToggle)
    return () => el.removeEventListener('hang4r-find-toggle', onToggle)
  }, [])

  // composer auto-grow: height follows content, capped at 30% of the chat
  // pane's own height (tile-body shares its height with chat-panel, since
  // they sit in the same horizontal split — a horizontal split only divides
  // width, not height). Beyond the cap the textarea scrolls internally.
  const composerMaxHeightRef = useRef(220)
  const resizeComposer = (): void => {
    const el = composerRef.current
    if (!el) return
    const max = composerMaxHeightRef.current
    // the stylesheet's own max-height is a fixed fallback; override it inline
    // so the 30%-of-pane cap actually takes effect
    el.style.maxHeight = `${max}px`
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, max)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }
  useEffect(() => {
    const host = bodyRef.current
    if (!host) return
    const update = (): void => {
      const h = host.getBoundingClientRect().height
      if (h > 0) composerMaxHeightRef.current = Math.max(56, Math.round(h * 0.3))
      resizeComposer()
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(host)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // re-measure whenever the draft changes, whether from typing or a
  // programmatic set (mention/slash pick, submit clearing it, etc.)
  useEffect(() => {
    resizeComposer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // keep the composer's "Changes N" pill in sync (turn end + any git mutation)
  const statusForCount = useHang4r((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const gitNonce = useHang4r((s) => s.gitNonce)
  useEffect(() => {
    let alive = true
    void window.hang4r.getChangedFiles(sessionId).then((f) => {
      if (alive) setChangedCount(f.length)
    })
    return () => {
      alive = false
    }
  }, [sessionId, statusForCount, commitMenuOpen, gitNonce])

  // ⌘P: when a file is requested for this session, make sure Files is open
  const diffToOpen = useHang4r((s) => s.diffToOpen)
  useEffect(() => {
    if (diffToOpen && diffToOpen.sessionId === sessionId) setContextTab('Diff')
  }, [diffToOpen, sessionId])
  const fileToOpen = useHang4r((s) => s.fileToOpen)
  useEffect(() => {
    if (fileToOpen && fileToOpen.sessionId === sessionId) setContextTab('Files')
  }, [fileToOpen, sessionId])
  // ⌘⇧F: surface the Files panel — FileBrowser flips itself into search mode
  const searchToOpen = useHang4r((s) => s.searchToOpen)
  useEffect(() => {
    if (searchToOpen && searchToOpen.sessionId === sessionId) setContextTab('Files')
  }, [searchToOpen, sessionId])
  // ⌘-clicked URL (terminal/chat) → surface the Browser panel
  const urlToOpen = useHang4r((s) => s.urlToOpen)
  useEffect(() => {
    if (urlToOpen && urlToOpen.sessionId === sessionId) setContextTab('Browser')
  }, [urlToOpen, sessionId])
  // agent-driven `hang4r browser goto` (no live tab) → surface the Browser panel
  const browserToShow = useHang4r((s) => s.browserToShow)
  useEffect(() => {
    if (browserToShow && browserToShow.sessionId === sessionId) setContextTab('Browser')
  }, [browserToShow, sessionId])
  // ⌃`: toggle the Terminal panel (VS Code muscle memory)
  const terminalToToggle = useHang4r((s) => s.terminalToToggle)
  useEffect(() => {
    if (terminalToToggle && terminalToToggle.sessionId === sessionId)
      setContextTab((cur) => (cur === 'Terminal' ? null : 'Terminal'))
  }, [terminalToToggle, sessionId])
  // ⤷ button on an agent row in chat → jump to the Subagents panel
  const subagentsToOpen = useHang4r((s) => s.subagentsToOpen)
  useEffect(() => {
    if (subagentsToOpen && subagentsToOpen.sessionId === sessionId) setContextTab('Subagents')
  }, [subagentsToOpen, sessionId])
  // ⌥⌘B: open → close (remembering the tab); closed → reopen the remembered tab
  const panelToToggle = useHang4r((s) => s.panelToToggle)
  useEffect(() => {
    if (panelToToggle && panelToToggle.sessionId === sessionId) {
      setContextTab((cur) => (cur ? null : lastContextTabRef.current))
    }
  }, [panelToToggle, sessionId])

  // load the workspace file list once for @-mentions
  useEffect(() => {
    void window.hang4r.listAllFiles(sessionId).then(setAllFiles)
  }, [sessionId])

  const mentionResults = useMentionResults(allFiles, mention?.query ?? '')

  // slash-menu items: built-in commands + session skills/commands + modes
  const slashItems: SlashItem[] = [
    { kind: 'command', name: 'rename', desc: 'rename this session' },
    { kind: 'command', name: 'status', desc: 'show context and token usage' },
    { kind: 'command', name: 'fork', desc: 'duplicate into a new session' },
    { kind: 'command', name: 'retry', desc: 'resend the last message' },
    ...(init?.slashCommands ?? []).map((c) => ({ kind: 'command' as const, name: c })),
    ...(init?.skills ?? []).map((s) => ({ kind: 'skill' as const, name: s })),
    { kind: 'mode', name: 'plan', desc: 'plan mode (read-only)' },
    { kind: 'mode', name: 'default', desc: 'default permissions' }
  ]
  const slashList = slash ? slashResults(slashItems, slash.query) : []

  // detect an @token immediately before the caret → open the mention picker
  const detectMention = (value: string, caret: number): void => {
    const upto = value.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(upto)
    if (m) {
      setMention({ query: m[2], start: caret - m[2].length - 1 })
      setMentionActive(0)
    } else {
      setMention(null)
    }
  }

  // detect a /token at composer start → open the slash-command menu
  const detectSlash = (value: string, caret: number): void => {
    const upto = value.slice(0, caret)
    const m = /(^|\s)\/([^\s]*)$/.exec(upto)
    if (m) {
      setSlash({ query: m[2], start: caret - m[2].length - 1 })
      setSlashActive(0)
    } else {
      setSlash(null)
    }
  }

  const pickSlash = (item: SlashItem): void => {
    const el = composerRef.current
    const caret = el?.selectionStart ?? draft.length
    const start = slash?.start ?? 0
    const next = draft.slice(0, start) + '/' + item.name + ' ' + draft.slice(caret)
    setDraft(sessionId, next)
    setSlash(null)
    setTimeout(() => el?.focus(), 0)
  }

  // add a File/Blob (pasted, dropped, or picked) as an attachment
  const addFileAttachment = async (file: File, fallbackName = 'pasted-image'): Promise<void> => {
    if (file.type.startsWith('image/')) {
      const base64 = await blobToBase64(file)
      addAttachment(sessionId, {
        label: file.name || `${fallbackName}.${file.type.split('/')[1] || 'png'}`,
        image: { base64, mediaType: file.type }
      })
    } else {
      const text = await file.text()
      addAttachment(sessionId, { label: file.name, text: `${file.name}\n${text.slice(0, 8000)}` })
    }
  }

  const onComposerPaste = (e: ReactClipboardEvent): void => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const it of Array.from(items)) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) {
          e.preventDefault()
          void addFileAttachment(f, 'clipboard')
        }
      }
    }
  }

  const attachRepoFile = async (path: string): Promise<void> => {
    const name = path.split('/').pop() ?? path
    const res = await window.hang4r.readFile(sessionId, path)
    addAttachment(sessionId, { label: name, text: `${path}\n${res.content.slice(0, 8000)}` })
  }
  const onComposerDrop = (e: ReactDragEvent): void => {
    // a file dragged from the Explorer → attach it as context
    const repoPath = e.dataTransfer?.getData('application/x-hang4r-file')
    if (repoPath) {
      e.preventDefault()
      setDropActive(false)
      void attachRepoFile(repoPath)
      return
    }
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) {
      e.preventDefault()
      setDropActive(false)
      files.forEach((f) => void addFileAttachment(f))
    }
  }

  const pickMention = (path: string): void => {
    if (!mention) return
    const el = composerRef.current
    const caret = el?.selectionStart ?? draft.length
    const name = path.split('/').pop() ?? path
    const next = draft.slice(0, mention.start) + '@' + name + ' ' + draft.slice(caret)
    setDraft(sessionId, next)
    void window.hang4r.readFile(sessionId, path).then((res) =>
      addAttachment(sessionId, { label: name, text: `${path}\n${res.content.slice(0, 8000)}` })
    )
    setMention(null)
    setTimeout(() => el?.focus(), 0)
  }

  if (!session) return null
  const running = session.status === 'running' || session.status === 'starting'
  const pickerModels =
    session.backend === 'codex'
      ? codexModels
      : session.backend === 'cursor'
        ? cursorModels
        : CLAUDE_PICKER_MODELS
  const sess = session

  const runCommit = async (mode: 'commit' | 'push' | 'branch' | 'pr'): Promise<void> => {
    setCommitMenuOpen(false)
    const store = useHang4r.getState()
    if (mode === 'pr') {
      setNotice('Committing & creating PR…')
      try {
        const url = await window.hang4r.createSessionPr(sessionId)
        setNotice(url ? `PR: ${url}` : 'PR created')
      } catch (e) {
        setNotice(`Failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      setChangedCount(0)
      return
    }
    const msg = await store.showPrompt('Commit message:', sess.title)
    if (msg === null) return
    let branch: string | null = null
    if (mode === 'branch') {
      branch = await store.showPrompt('New branch name:', slugish(sess.title))
      if (!branch?.trim()) return
    }
    setNotice('Committing…')
    try {
      if (mode === 'commit') await window.hang4r.commitSession(sessionId, msg)
      else if (mode === 'push') await window.hang4r.commitPushSession(sessionId, msg)
      else if (mode === 'branch')
        await window.hang4r.branchCommitPushSession(sessionId, branch!.trim(), msg)
      setNotice(mode === 'commit' ? 'Committed' : 'Committed & pushed')
      const f = await window.hang4r.getChangedFiles(sessionId)
      setChangedCount(f.length)
      useHang4r.getState().bumpGit()
    } catch (e) {
      setNotice(`Commit failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const flash = (msg: string, ms = 3500): void => {
    setNotice(msg)
    setTimeout(() => setNotice(null), ms)
  }

  /** change the permission mode + flash a composer notice explaining when it applies */
  const changePermissionMode = (mode: PermissionMode): void => {
    if (!session || session.permissionMode === mode) return
    void setSessionPermissionMode(sessionId, mode)
    const when = running ? 'after the current turn' : 'to the next message'
    flash(`Permission mode: ${PERMISSION_MODE_LABEL[mode]} — applies ${when}`)
  }

  /** Shift+Tab cycles modes in the CLI's order (default → acceptEdits → plan → bypass → …) */
  const cyclePermissionMode = (): void => {
    if (!session) return
    const i = PERMISSION_MODES.findIndex((m) => m.value === session.permissionMode)
    const next = PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]
    changePermissionMode(next.value)
  }

  const handleSlash = (text: string): boolean => {
    const [cmd, ...rest] = text.slice(1).split(' ')
    switch (cmd) {
      case 'rename': {
        const name = rest.join(' ').trim()
        if (name) void renameSession(sessionId, name)
        flash(`${text} ✓`)
        return true
      }
      case 'status': {
        const usage = useHang4r.getState().sessionUsage[sessionId]
        const ctx = usage?.contextTokens ?? 0
        const max =
          usage?.contextWindowTokens ?? contextWindow(session?.model, session?.backend, pickerModels)
        const windowText = max
          ? ` / ${fmtTok(max)} (${Math.min(100, Math.round((ctx / max) * 100))}%)`
          : ' / unknown'
        flash(
          `context ${fmtTok(ctx)}${windowText} · ${fmtTok(usage?.inputTokens ?? 0)}↓ ${fmtTok(
            usage?.outputTokens ?? 0
          )}↑`,
          5000
        )
        return true
      }
      case 'fork':
      case 'duplicate':
        void duplicateSession(sessionId)
        flash(`${text} ✓`)
        return true
      case 'retry':
        void retrySession(sessionId)
        flash(`${text} ✓`)
        return true
      // CLI commands that don't work in embedded (stream-json) sessions get
      // hang4r-native equivalents instead of "isn't available" dead ends
      case 'mcp':
        setContextTab('Env')
        flash('MCP servers are listed in the Env panel →')
        return true
      case 'usage':
        flash('Live usage gauges are in the sidebar (Claude/Codex usage), the top bar, and /status')
        return true
      case 'hooks':
        setContextTab('Hooks')
        flash('Hook activity is in the Hooks panel →')
        return true
      // interactive-only CLI commands. /remote-control genuinely needs THIS
      // conversation (--resume) — note: the interactive CLI may then advance
      // it (e.g. finish pending background agents), so its output can differ
      // from what hang4r streamed. The diagnostics commands are conversation-
      // independent — run them in a plain interactive claude, zero divergence.
      case 'remote-control': {
        const resume = session?.backendSessionId ? ` --resume ${session.backendSessionId}` : ''
        // carry the hang4r session name into the CLI (picker + terminal title
        // + claude.ai remote-control list all show it)
        const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
        const name = session?.title ? ` --name ${shq(session.title)}` : ''
        // inherit THIS session's permission mode — without it the resumed CLI
        // defaults to prompting, so the remote conversation asked for approvals
        // the desktop session had already been granted (Angel: "not the same
        // permissions we granted"). Same mapping the claude adapter uses.
        const perm =
          session?.permissionMode === 'bypassPermissions'
            ? ' --dangerously-skip-permissions'
            : session?.permissionMode
              ? ` --permission-mode ${session.permissionMode}`
              : ''
        useHang4r.getState().runInTerminal(sessionId, `claude${resume}${perm}${name} "/${cmd}"`, `/${cmd}`)
        setContextTab('Terminal')
        flash(
          'Running /remote-control on this conversation → note: turns taken in that terminal live in the CLI, not in this transcript',
          7000
        )
        return true
      }
      case 'doctor':
      case 'config':
      case 'login': {
        useHang4r.getState().runInTerminal(sessionId, `claude --name 'hang4r /${cmd}' "/${cmd}"`, `/${cmd}`)
        setContextTab('Terminal')
        flash(`Running /${cmd} in an interactive Claude →`, 5000)
        return true
      }
      case 'ide':
        flash('/ide connects the CLI to an external editor — hang4r already is your editor', 4500)
        return true
      default:
        return false
    }
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text && attachments.length === 0) return
    // slash commands are local UI actions — run them immediately, even mid-turn
    // (handleSlash is a no-op returning false for anything it doesn't recognize)
    if (text.startsWith('/') && handleSlash(text)) {
      setDraft(sessionId, '')
      return
    }
    // While the agent is running, submitting QUEUES the message (Cursor-style)
    // instead of dropping it — it auto-sends when the turn completes.
    if (running) {
      setDraft(sessionId, '')
      queueMessage(sessionId, text)
      return
    }
    setDraft(sessionId, '')
    void sendPrompt(sessionId, text)
  }

  /** Select text in the CHAT or DIFF content → floating "Add to chat".
   *  Deliberately NOT in the file tree / explorer / editor tabs. */
  const onBodyMouseUp = (e: MouseEvent): void => {
    const target = e.target as HTMLElement
    if (target.closest('.sel-popup')) return
    // only offer add-to-chat for readable content, not navigation chrome
    if (!target.closest('.chat-scroll') && !target.closest('.diff-body')) {
      setSelPopup(null)
      return
    }
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (!text || !bodyRef.current) {
      setSelPopup(null)
      return
    }
    const range = sel!.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const host = bodyRef.current.getBoundingClientRect()
    // anchor BELOW the selection end so it never collides with panel headers
    setSelPopup({
      text,
      x: Math.max(60, Math.min(rect.left - host.left + rect.width / 2, host.width - 80)),
      y: Math.min(rect.bottom - host.top + 8, host.height - 40)
    })
  }

  // the popup must vanish the moment the selection does (typing, Esc, click
  // elsewhere, programmatic clear) and on scroll, where its anchor goes stale
  useEffect(() => {
    if (!selPopup) return
    const onSelChange = (): void => {
      if (!(window.getSelection()?.toString().trim() ?? '')) setSelPopup(null)
    }
    const onScroll = (): void => setSelPopup(null)
    document.addEventListener('selectionchange', onSelChange)
    const body = bodyRef.current
    body?.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('selectionchange', onSelChange)
      body?.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [selPopup])

  const addSelectionToChat = (): void => {
    if (!selPopup) return
    const firstLine = selPopup.text.split('\n')[0].slice(0, 24)
    addAttachment(sessionId, {
      label: `“${firstLine}${selPopup.text.length > 24 ? '…' : ''}”`,
      text: selPopup.text
    })
    setSelPopup(null)
    window.getSelection()?.removeAllRanges()
  }

  const toggleContext = (tab: ContextTab): void => {
    setContextTab((cur) => (cur === tab ? null : tab))
  }

  const contextView = (tab: ContextTab): JSX.Element => {
    switch (tab) {
      case 'Files':
        return <FileBrowser sessionId={sessionId} />
      case 'Diff':
        return <DiffView sessionId={sessionId} />
      case 'Terminal':
        return <TerminalPanel sessionId={sessionId} />
      case 'Processes':
        return <ProcessesPanel sessionId={sessionId} />
      case 'Browser':
        return <BrowserPane sessionId={sessionId} />
      case 'Subagents':
        return <SubagentInspector sessionId={sessionId} />
      case 'Tasks':
        return <BackgroundTasks sessionId={sessionId} />
      case 'Hooks':
        return <HooksTimeline sessionId={sessionId} />
      case 'Env':
        return <EnvBrowser sessionId={sessionId} />
    }
  }

  return (
    <section
      className={'tile' + (focused ? ' tile-focused' : '')}
      onMouseDown={() => focusSession(sessionId)}
    >
      <header
        className="tile-header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-hang4r-session', sessionId)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          const store = useHang4r.getState()
          store.openContextMenu(e.clientX, e.clientY, [
            {
              label: 'Rename…',
              onClick: () => {
                setTitleDraft(session.title)
                setRenaming(true)
              }
            },
            { label: 'Duplicate / Fork', onClick: () => void duplicateSession(sessionId) },
            { label: 'Retry Last Message', onClick: () => void retrySession(sessionId) },
            {
              // hang4r sessions live in a worktree cwd + are unnamed, so they
              // don't show in the raw CLI's resume picker — hand over the exact
              // resume-by-id command (this backend, this session, same perms)
              label: 'Resume in CLI (terminal)',
              onClick: () => {
                if (!session.backendSessionId) {
                  flash('This session has no CLI session yet — send a message first.', 4000)
                  return
                }
                const { cmd, label } = resumeCliCommand(
                  session.backend,
                  session.backendSessionId,
                  session.title,
                  session.permissionMode
                )
                useHang4r.getState().runInTerminal(sessionId, cmd, label)
                setContextTab('Terminal')
                flash(
                  'Resuming this conversation in a terminal → turns you take there sync back into hang4r when you return to the window',
                  6500
                )
              }
            },
            { label: expanded ? 'Restore Layout' : 'Expand Pane', shortcut: '⌘⇧E', onClick: () => toggleExpand(sessionId) },
            { separator: true, label: '' },
            { label: 'Close Pane', shortcut: '⌘W', danger: true, onClick: () => closeTile(sessionId) }
          ])
        }}
      >
        <span className={`status-dot status-${session.status}`} />
        {renaming ? (
          <input
            className="tile-title-input"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false)
              if (titleDraft.trim()) void renameSession(sessionId, titleDraft.trim())
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="tile-title-group">
            <span
              className="tile-title"
              title={`${session.cwd} — double-click to rename, drag to move pane`}
              onDoubleClick={() => {
                setTitleDraft(session.title)
                setRenaming(true)
              }}
            >
              {session.title}
            </span>
            {workspace && (
              <span className="tile-repo" title={session.cwd}>
                <span className="tile-repo-name">⬡ {workspace.name}</span>
                <span className="tile-repo-branch">
                  ⑂ {session.environment === 'worktree' ? wtBranch ?? '…' : session.baseRef || 'local'}
                </span>
              </span>
            )}
          </span>
        )}
        <nav className="tile-tabs">
          {/* ALL panels stay visible as tabs — Angel was explicit that hiding
              any behind a menu reads as removed features. Overflow at narrow
              widths is handled by compact sizing + a visible scroll hint. */}
          {CONTEXT_TABS.map((t) => (
            <button
              key={t}
              className={'tile-tab' + (t === contextTab ? ' tile-tab-active' : '')}
              title={t === contextTab ? `Close ${t} panel` : `Open ${t} next to chat`}
              onClick={() => toggleContext(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <button
          className="ghost-btn tile-action"
          title="Retry last message"
          onClick={() => void retrySession(sessionId)}
        >
          <Icon name="refresh" size={15} />
        </button>
        <button
          className="ghost-btn tile-action"
          title="Duplicate session — fork"
          onClick={() => void duplicateSession(sessionId)}
        >
          <Icon name="copy" size={15} />
        </button>
        <button
          className="ghost-btn tile-action"
          title={expanded ? 'Restore layout — ⌘⇧E' : 'Expand pane — ⌘⇧E'}
          onClick={() => toggleExpand(sessionId)}
        >
          <Icon name={expanded ? 'minimize' : 'maximize'} size={15} />
        </button>
        <button
          className={'ghost-btn tile-action' + (contextTab ? ' ghost-btn-on' : '')}
          title={contextTab ? 'Hide side panel — ⌥⌘B' : 'Show side panel — ⌥⌘B'}
          onClick={() => setContextTab((cur) => (cur ? null : lastContextTabRef.current))}
        >
          <Icon name="panel-right" size={15} />
        </button>
        <button
          className="ghost-btn tile-action"
          title="Close pane — ⌘W"
          onClick={() => closeTile(sessionId)}
        >
          <Icon name="close" size={15} />
        </button>
      </header>

      <div className="tile-body" ref={bodyRef} onMouseUp={onBodyMouseUp}>
        {selPopup && (
          <button className="sel-popup" style={{ left: selPopup.x, top: selPopup.y }} onClick={addSelectionToChat}>
            ↳ Add to chat
          </button>
        )}
        <Group orientation="horizontal" className="pane-group">
          <Panel minSize="25%" defaultSize="46%" className="chat-panel">
            <ChatView
              items={transcript?.items ?? []}
              sessionId={sessionId}
              running={running}
              scrollRef={chatScrollRef}
              findOpen={findOpen}
            />
            {findOpen && (
              <ChatFindBar
                containerRef={chatScrollRef}
                focusToken={findToken}
                onClose={() => {
                  setFindOpen(false)
                  composerRef.current?.focus()
                }}
              />
            )}
            <footer className="composer-wrap">
              {notice && <div className="composer-notice">{notice}</div>}
              {changedCount > 0 && (
                <div className="composer-git">
                  <span
                    className="changes-pill"
                    title="Uncommitted changes — click to review"
                    onClick={() => {
                      focusSession(sessionId)
                      openReviewFor(sessionId)
                      setContextTab('Diff')
                    }}
                  >
                    Changes <b>{changedCount}</b>
                  </span>
                  <div className="commit-split" ref={commitSplitRef}>
                    <button className="commit-main" onClick={() => void runCommit('branch')}>
                      Create Branch &amp; Commit
                    </button>
                    <button
                      className="commit-caret"
                      title="Commit options"
                      onClick={() => {
                        const r = commitSplitRef.current?.getBoundingClientRect()
                        if (r)
                          setCommitMenuPos({
                            right: window.innerWidth - r.right,
                            bottom: window.innerHeight - r.top + 4
                          })
                        setCommitMenuOpen((o) => !o)
                      }}
                    >
                      ▾
                    </button>
                    {commitMenuOpen &&
                      commitMenuPos &&
                      createPortal(
                        <>
                          <div className="menu-backdrop" onClick={() => setCommitMenuOpen(false)} />
                          <div
                            className="commit-menu commit-menu-portal"
                            style={{ right: commitMenuPos.right, bottom: commitMenuPos.bottom }}
                          >
                            <button onClick={() => void runCommit('branch')}>
                              Create Branch, Commit &amp; Push
                            </button>
                            <button onClick={() => void runCommit('push')}>Commit &amp; Push</button>
                            <button onClick={() => void runCommit('commit')}>Commit</button>
                            <button onClick={() => void runCommit('pr')}>Commit &amp; Create PR</button>
                          </div>
                        </>,
                        document.body
                      )}
                  </div>
                </div>
              )}
              {queued.length > 0 && (
                <div className="composer-queue">
                  <div className="queue-header">
                    <span className="queue-count">{queued.length} Queued</span>
                    <span className="queue-hint">⏎ to send</span>
                  </div>
                  {queued.map((m) => (
                    <div key={m.id} className="queue-row" title={m.text}>
                      {m.attachments.some((a) => a.image) && (
                        <span className="queue-row-img" title="has an attached image">
                          <Icon name="paperclip" size={12} />
                        </span>
                      )}
                      <span className="queue-row-text">{m.text}</span>
                      <div className="queue-row-actions">
                        <button
                          className="queue-row-btn"
                          title="Edit — move this back into the composer"
                          onClick={() => {
                            // simplest honest edit: pull the text back into the
                            // composer and drop the queued copy (reuse setDraft +
                            // removeQueuedMessage — no dedicated edit action)
                            setDraft(sessionId, m.text)
                            removeQueuedMessage(sessionId, m.id)
                            composerRef.current?.focus()
                          }}
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                        <button
                          className="queue-row-btn"
                          title="Send now — interrupt the current turn and send this next"
                          onClick={() => void sendQueuedNow(sessionId, m.id)}
                        >
                          <Icon name="arrow-up" size={13} />
                        </button>
                        <button
                          className="queue-row-btn queue-row-del"
                          title="Remove from queue"
                          onClick={() => removeQueuedMessage(sessionId, m.id)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div
                className={'composer' + (dropActive ? ' composer-drop-active' : '')}
                onDrop={onComposerDrop}
                onDragOver={(e) => {
                  // a dragged SESSION is a pane-split gesture — let it bubble to
                  // the workspace pane instead of showing the file-drop highlight
                  if (e.dataTransfer.types.includes('application/x-hang4r-session')) return
                  e.preventDefault()
                  if (!dropActive) setDropActive(true)
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget === e.target) setDropActive(false)
                }}
              >
                {attachments.length > 0 && (
                  <div className="composer-chips">
                    {attachments.map((a, i) => (
                      <span
                        key={i}
                        className={'context-chip' + (a.image ? ' context-chip-image' : '')}
                        title={a.image ? a.label : a.text?.slice(0, 400)}
                      >
                        {a.image ? (
                          <img
                            className="chip-thumb"
                            src={`data:${a.image.mediaType};base64,${a.image.base64}`}
                            alt={a.label}
                          />
                        ) : (
                          '⌗ '
                        )}
                        {a.label}
                        <button
                          className="context-chip-x"
                          onClick={() => removeAttachment(sessionId, i)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {mention && mentionResults.length > 0 && (
                  <MentionMenu
                    files={allFiles}
                    query={mention.query}
                    active={mentionActive}
                    onPick={pickMention}
                    onHover={setMentionActive}
                  />
                )}
                {slash && slashList.length > 0 && (
                  <SlashMenu
                    items={slashItems}
                    query={slash.query}
                    active={slashActive}
                    onPick={pickSlash}
                    onHover={setSlashActive}
                  />
                )}
                <textarea
                  ref={composerRef}
                  className="composer-input"
                  placeholder={running ? 'Agent is working… ⏎ queues a follow-up' : 'Send follow-up… (@ file · / command)'}
                  value={draft}
                  onChange={(e) => {
                    setDraft(sessionId, e.target.value)
                    detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
                    detectSlash(e.target.value, e.target.selectionStart ?? e.target.value.length)
                  }}
                  onPaste={onComposerPaste}
                  onKeyDown={(e) => {
                    // Shift+Tab cycles permission modes (the CLI's own shortcut);
                    // preventDefault so focus stays in the composer
                    if (e.key === 'Tab' && e.shiftKey) {
                      e.preventDefault()
                      cyclePermissionMode()
                      return
                    }
                    if (mention && mentionResults.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setMentionActive((a) => Math.min(a + 1, mentionResults.length - 1))
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setMentionActive((a) => Math.max(a - 1, 0))
                        return
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault()
                        pickMention(mentionResults[mentionActive])
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setMention(null)
                        return
                      }
                    }
                    if (slash && slashList.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setSlashActive((a) => Math.min(a + 1, slashList.length - 1))
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setSlashActive((a) => Math.max(a - 1, 0))
                        return
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault()
                        pickSlash(slashList[slashActive])
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setSlash(null)
                        return
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      submit()
                    }
                  }}
                />
                <div className="composer-bar">
                  <div className="composer-attach-wrap">
                    <button
                      className="composer-attach"
                      title="Attach files as context"
                      onClick={() => setAttachOpen((o) => !o)}
                    >
                      ＋
                    </button>
                    {attachOpen && (
                      <AttachMenu sessionId={sessionId} onClose={() => setAttachOpen(false)} />
                    )}
                  </div>
                  <button
                    className="composer-upload"
                    title="Upload an image or file from your computer"
                    onClick={() =>
                      void window.hang4r
                        .pickAttachments()
                        .then((atts) => atts.forEach((a) => addAttachment(sessionId, a)))
                    }
                  >
                    <Icon name="paperclip" size={14} />
                  </button>
                  <span className="composer-hint">/rename · /fork · /retry</span>
                  <ComposerContext
                    sessionId={sessionId}
                    model={session.model}
                    backend={session.backend}
                    models={pickerModels}
                    running={running}
                  />
                  <span className="perm-mode-wrap">
                    <select
                      className="perm-mode-select"
                      title="Permission mode (Shift+Tab to cycle)"
                      value={session.permissionMode}
                      onChange={(e) => changePermissionMode(e.target.value as PermissionMode)}
                    >
                      {PERMISSION_MODES.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <kbd className="perm-mode-hint" aria-hidden="true">
                      ⇧⇥
                    </kbd>
                  </span>
                  <ModelPicker
                    choices={pickerModels}
                    model={
                      session.model &&
                      pickerModels.some((m) => m.value === session.model)
                        ? session.model
                        : ''
                    }
                    effort={effort}
                    // real effort levers exist for claude (--effort) and codex
                    // (model_reasoning_effort); cursor bakes effort into the
                    // model slug itself — chips there would be a dead control
                    showEffort={session.backend !== 'cursor'}
                    onSetModel={(v) => void window.hang4r.setSessionModel(sessionId, v)}
                    onSetEffort={(v) => {
                      setEffortState(v)
                      void window.hang4r.setSessionEffort(sessionId, v)
                    }}
                  />
                  {running ? (
                    <button className="ghost-btn composer-stop" onClick={() => interrupt(sessionId)}>
                      ◼ Stop
                    </button>
                  ) : (
                    <button
                      className="primary-btn composer-send"
                      disabled={!draft.trim() && attachments.length === 0}
                      onClick={submit}
                    >
                      Send
                    </button>
                  )}
                </div>
              </div>
            </footer>
          </Panel>
          {contextTab && (
            <>
              <Separator className="resize-handle resize-handle-v" />
              <Panel minSize="20%" defaultSize="42%" className="context-panel">
                <div className="context-header">
                  <span>{contextTab}</span>
                  <button className="ghost-btn" title="Close panel" onClick={() => setContextTab(null)}>
                    ×
                  </button>
                </div>
                <div className="context-body">{contextView(contextTab)}</div>
              </Panel>
            </>
          )}
        </Group>
        {/* Collapsed representation of the panel (Cursor-style): a slim icon
            rail at the tile's right edge, shown only while no panel is open.
            Clicking an icon opens that surface directly; « restores whatever
            was last open (same action as ⌥⌘B). */}
        {!contextTab && (
          <div className="context-rail">
            {/* aria-label deliberately avoids the tab strip's own accessible
                names ("Terminal"/"Files"/"Browser") — with no text content a
                button's accessible name falls back to `title`, and tests query
                the tab strip by those exact names (tile.getByRole('button',
                { name: 'Terminal' })); a substring match against this rail
                would make that query ambiguous. `title` still shows the plain
                tooltip on hover. */}
            <button
              className="context-rail-btn"
              title="Open Browser"
              aria-label="Rail: open web pane"
              onClick={() => setContextTab('Browser')}
            >
              <Icon name="globe" size={15} />
            </button>
            <button
              className="context-rail-btn"
              title="Open Terminal"
              aria-label="Rail: open shell pane"
              onClick={() => setContextTab('Terminal')}
            >
              <Icon name="terminal" size={15} />
            </button>
            <button
              className="context-rail-btn"
              title="Open Files"
              aria-label="Rail: open explorer pane"
              onClick={() => setContextTab('Files')}
            >
              <Icon name="files" size={15} />
            </button>
            <button
              className="context-rail-btn context-rail-expand"
              title="Show Panel ⌥⌘B"
              onClick={() => setContextTab(lastContextTabRef.current)}
            >
              <Icon name="chevrons-left" size={15} />
            </button>
          </div>
        )}
      </div>

      <footer className="tile-status">
        <span>{session.backend}</span>
        <span>{session.environment === 'worktree' ? '⌥ worktree' : 'in-place'}</span>
        {session.model && <span>{session.model.replace('claude-', '')}</span>}
        <span>{session.permissionMode}</span>
        <SessionUsage
          sessionId={sessionId}
          cost={session.totalCostUsd}
          model={session.model}
          backend={session.backend}
          models={pickerModels}
        />
        {session.lastError && <span className="tile-status-error">{session.lastError}</span>}
      </footer>
    </section>
  )
}
