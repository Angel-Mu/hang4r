import { create } from 'zustand'
import { applyTheme, type Theme } from '../theme'
import { forgetSessionUiState, seedSessionUi } from '../sessionUiMemos'
import type {
  AgentEvent,
  AgentQuestion,
  Attachment,
  BrowserHotkeyAction,
  PermissionMode,
  Project,
  QuestionAnswer,
  ReviewComment,
  SessionEvent,
  SessionMeta
} from '../../../shared/protocol'

export interface ContextMenuItem {
  label: string
  shortcut?: string
  danger?: boolean
  separator?: boolean
  onClick?: () => void
}

/**
 * A message the user submitted while the agent was still running. It waits in a
 * per-session FIFO and auto-sends when the turn completes (session → idle). Not
 * persisted to the DB — a queued message dies with the app (fine for v1).
 */
export interface BrowserTab {
  id: string
  /** what's in the URL bar */
  url: string
  /** the loaded webview src (null = empty tab) */
  current: string | null
  /** ssh: remote port being viewed through an ssh -L tunnel */
  tunneledPort: number | null
}

export interface QueuedMessage {
  id: string
  text: string
  /** attachments (incl. images) snapshotted at queue time so they survive */
  attachments: Attachment[]
}

/** Compose a prompt + its attachments into the (text, images) the agent sees. */
function composeMessage(
  text: string,
  atts: Attachment[]
): { full: string; images: { base64: string; mediaType: string }[] } {
  let full = text
  const textAtts = atts.filter((a) => a.text)
  const images = atts
    .filter((a) => a.image)
    .map((a) => ({ base64: a.image!.base64, mediaType: a.image!.mediaType }))
  if (textAtts.length > 0) {
    const blocks = textAtts.map((a) => `${a.label}:\n\`\`\`\n${a.text}\n\`\`\``).join('\n\n')
    full = `${blocks}\n\n${text}`
  }
  return { full, images }
}

/** A renderable transcript item, reduced from the agent event stream */
export type TranscriptItem =
  | { type: 'user'; text: string; images?: { base64: string; mediaType: string }[] }
  | {
      type: 'block'
      key: string
      blockType: 'text' | 'thinking' | 'tool_use'
      text: string
      toolName?: string
      toolUseId?: string
      toolInput?: unknown
      toolResult?: unknown
      toolResultError?: boolean
      final: boolean
      parentToolUseId: string | null
    }
  | {
      type: 'turn-info'
      isError: boolean
      errorMessage?: string
      costUsd?: number
      durationMs?: number
    }
  | {
      type: 'permission'
      toolUseId?: string
      requestId: string
      tool: string
      summary: string
      detail?: string
      options: string[]
      decision?: string
    }
  | {
      type: 'question'
      requestId: string
      title?: string
      questions: AgentQuestion[]
      /** the user's submitted answers, once answered (undefined = still open) */
      answers?: QuestionAnswer[]
      /** the turn ended before the user answered (interrupt/error) */
      cancelled?: boolean
    }
  | {
      type: 'plan'
      entries: { step: string; status: 'pending' | 'inProgress' | 'completed' }[]
    }
  | { type: 'subagent-note'; text: string }
  | { type: 'setup-note'; text: string; isError?: boolean }
  | { type: 'external-turn'; role: 'user' | 'assistant'; text: string }

export interface HookRun {
  hookEvent: string
  hookName: string
  status: 'running' | 'done'
  outcome?: string
}

export interface Transcript {
  items: TranscriptItem[]
  /** block key -> index in items */
  blockIndex: Map<string, number>
  /** toolUseId -> index in items */
  toolIndex: Map<string, number>
  /** lifecycle hook events (PreToolUse/PostToolUse/…) for the hooks timeline */
  hooks: HookRun[]
  /** highest event seq applied — replay + live streams dedupe on this */
  lastSeq: number
}

function emptyTranscript(): Transcript {
  return { items: [], blockIndex: new Map(), toolIndex: new Map(), hooks: [], lastSeq: 0 }
}

/**
 * True while a session has a permission request the user hasn't answered yet.
 * The single source of truth for "this session needs you" — the sidebar's
 * amber status dot, the per-row action badge, and the collapsed workspace's
 * count chip all read this instead of re-deriving it, so they can't disagree.
 * (The main-process notification pipeline fires on the same underlying
 * `permission-request` event that puts an item here, so it agrees too.)
 */
export function isAwaitingPermission(t: Transcript | undefined): boolean {
  return !!t && t.items.some((it) => it.type === 'permission' && it.decision === undefined)
}

/**
 * True while a session has an unanswered question-request (Claude
 * AskUserQuestion). Same "this session needs you" signal as isAwaitingPermission
 * — the sidebar amber dot ORs the two so a held question lights it too.
 */
export function isAwaitingQuestion(t: Transcript | undefined): boolean {
  return (
    !!t &&
    t.items.some((it) => it.type === 'question' && it.answers === undefined && !it.cancelled)
  )
}

interface LoadedTranscript {
  transcript: Transcript
  inputTokens: number
  outputTokens: number
  contextTokens: number
  contextWindowTokens: number | undefined
}

/**
 * Resync + replay a session's persisted events into a transcript and its
 * derived usage summary. Shared by openSession (always refreshes) and
 * ensureTranscript (only calls this when nothing is loaded yet) so a session
 * dropped straight into a split pane gets the same replay a normal open does.
 */
async function loadTranscriptData(sessionId: string): Promise<LoadedTranscript> {
  // pull in turns taken in an external interactive CLI (/remote-control) —
  // imported events are part of getSessionEvents below; live ones broadcast
  try {
    await window.hang4r.resyncSession(sessionId)
  } catch {
    /* non-fatal */
  }
  const events = await window.hang4r.getSessionEvents(sessionId)
  const t = emptyTranscript()
  // rebuild per-session usage from replayed turn-completes so the context
  // gauge is populated for restored/imported sessions (not only live ones)
  let inTok = 0
  let outTok = 0
  let ctxTok = 0
  let ctxWindow: number | undefined
  for (const e of events) {
    applyEvent(t, e.event)
    t.lastSeq = Math.max(t.lastSeq, e.seq)
    if (e.event.kind === 'turn-complete') {
      inTok += e.event.inputTokens ?? 0
      outTok += e.event.outputTokens ?? 0
      ctxTok = e.event.contextTokens ?? e.event.inputTokens ?? ctxTok
      ctxWindow = e.event.contextWindowTokens ?? ctxWindow
    } else if (e.event.kind === 'usage') {
      ctxTok = e.event.contextTokens ?? ctxTok
      ctxWindow = e.event.contextWindowTokens ?? ctxWindow
    }
  }
  return {
    transcript: t,
    inputTokens: inTok,
    outputTokens: outTok,
    contextTokens: ctxTok,
    contextWindowTokens: ctxWindow
  }
}

/** Apply one agent event to a transcript (mutates the given transcript copy) */
export function applyEvent(t: Transcript, ev: AgentEvent): void {
  switch (ev.kind) {
    case 'user-text':
      t.items.push({ type: 'user', text: ev.text, images: ev.images })
      break
    case 'external-turn':
      t.items.push({ type: 'external-turn', role: ev.role, text: ev.text })
      break
    case 'subagent-note':
      t.items.push({ type: 'subagent-note', text: ev.text })
      break
    case 'setup-note':
      t.items.push({ type: 'setup-note', text: ev.text, isError: ev.isError })
      break
    case 'block-start': {
      const key = `${ev.messageId}:${ev.blockIndex}`
      if (t.blockIndex.has(key)) break
      t.blockIndex.set(key, t.items.length)
      t.items.push({
        type: 'block',
        key,
        blockType: ev.blockType,
        text: '',
        toolName: ev.toolName,
        final: false,
        parentToolUseId: ev.parentToolUseId
      })
      break
    }
    case 'block-delta': {
      const key = `${ev.messageId}:${ev.blockIndex}`
      const idx = t.blockIndex.get(key)
      if (idx === undefined) break
      const item = t.items[idx]
      if (item.type === 'block' && !item.final) item.text += ev.text
      break
    }
    case 'block-final': {
      const key = `${ev.messageId}:${ev.blockIndex}`
      let idx = t.blockIndex.get(key)
      if (idx === undefined) {
        idx = t.items.length
        t.blockIndex.set(key, idx)
        t.items.push({
          type: 'block',
          key,
          blockType: ev.block.type,
          text: '',
          final: false,
          parentToolUseId: ev.parentToolUseId
        })
      }
      const item = t.items[idx]
      if (item.type !== 'block') break
      item.final = true
      if (ev.block.type === 'text') {
        item.blockType = 'text'
        item.text = ev.block.text
      } else if (ev.block.type === 'thinking') {
        item.blockType = 'thinking'
        item.text = ev.block.thinking
      } else if (ev.block.type === 'tool_use') {
        item.blockType = 'tool_use'
        item.toolName = ev.block.name
        item.toolUseId = ev.block.id
        item.toolInput = ev.block.input
        t.toolIndex.set(ev.block.id, idx)
      }
      break
    }
    case 'tool-result': {
      const idx = t.toolIndex.get(ev.toolUseId)
      if (idx === undefined) break
      const item = t.items[idx]
      if (item.type === 'block') {
        item.toolResult = ev.content
        item.toolResultError = ev.isError
      }
      break
    }
    case 'turn-complete':
      // a permission/question still pending when its turn ends (interrupt,
      // error) is dead — cancel it so the card stops offering live actions
      cancelStalePending(t)
      t.items.push({
        type: 'turn-info',
        isError: ev.isError,
        errorMessage: ev.errorMessage,
        costUsd: ev.costUsd,
        durationMs: ev.durationMs
      })
      break
    case 'plan': {
      // one live plan card per session: update in place, append if first
      const existing = t.items.findIndex((i) => i.type === 'plan')
      if (existing !== -1) {
        t.items[existing] = { type: 'plan', entries: ev.entries }
      } else {
        t.items.push({ type: 'plan', entries: ev.entries })
      }
      break
    }
    case 'permission-request':
      t.items.push({
        type: 'permission',
        requestId: ev.requestId,
        tool: ev.tool,
        summary: ev.summary,
        detail: ev.detail,
        options: ev.options,
        toolUseId: ev.toolUseId
      })
      break
    case 'permission-resolved':
      for (const item of t.items) {
        if (item.type === 'permission' && item.requestId === ev.requestId) {
          item.decision = ev.decision
        }
      }
      break
    case 'question-request':
      t.items.push({
        type: 'question',
        requestId: ev.requestId,
        title: ev.title,
        questions: ev.questions
      })
      break
    case 'question-resolved':
      for (const item of t.items) {
        if (item.type === 'question' && item.requestId === ev.requestId) {
          item.answers = ev.answers
        }
      }
      break
    case 'hook': {
      if (ev.phase === 'started') {
        t.hooks.push({
          hookEvent: ev.hookEvent,
          hookName: ev.hookName,
          status: 'running'
        })
      } else {
        // pair the response with the most recent matching open hook run
        for (let i = t.hooks.length - 1; i >= 0; i--) {
          const h = t.hooks[i]
          if (h.status === 'running' && h.hookName === ev.hookName && h.hookEvent === ev.hookEvent) {
            h.status = 'done'
            h.outcome = ev.outcome
            break
          }
        }
      }
      break
    }
    case 'exit':
      // the agent process died while a permission/question was still pending
      // (crash, kill, SSH drop) — this path emits NO turn-complete, so without
      // this the card would stay clickable for a dead request and the sidebar
      // "needs you" dot would stay lit even as the session flips to error.
      cancelStalePending(t)
      break
    default:
      // init, rate-limit, stderr — surfaced elsewhere (status bar,
      // gauges, session meta), not in the chat transcript
      break
  }
}

/**
 * Mark any still-pending permission/question as dead. Its turn ended
 * (turn-complete: normal finish, error, or interrupt) OR the agent process
 * exited — in every case the control request can never be answered, so the card
 * must stop offering live actions and `isAwaiting*` must go false. Shared by the
 * turn-complete and exit reducers so the two can never drift.
 */
function cancelStalePending(t: Transcript): void {
  for (const item of t.items) {
    if (item.type === 'permission' && item.decision === undefined) item.decision = 'cancelled'
    if (item.type === 'question' && item.answers === undefined) item.cancelled = true
  }
}

interface Hang4rState {
  projects: Project[]
  sessions: SessionMeta[]
  transcripts: Record<string, Transcript>
  /** sessions currently open as tiles, in tile order */
  openSessionIds: string[]
  focusedSessionId: string | null
  /** when set, that pane renders full-size (Cursor's expand-to-focus) */
  expandedSessionId: string | null
  newSessionProjectId: string | null
  /** live token totals since app start (cost aggregates from session meta) */
  usage: { inputTokens: number; outputTokens: number }
  /** per-session usage: cumulative tokens + last turn's context (input) size */
  sessionUsage: Record<
    string,
    { inputTokens: number; outputTokens: number; contextTokens: number; contextWindowTokens?: number }
  >
  /** per-session loaded context from the init event (skills, mcp, plugins, tools) */
  sessionInit: Record<
    string,
    {
      model: string
      version: string
      tools: string[]
      skills: string[]
      slashCommands: string[]
      mcpServers: { name: string; status: string }[]
      plugins: { name: string }[]
    }
  >
  /** latest rate-limit state per type (e.g. five_hour, weekly) */
  rateLimits: Record<string, { status: string; resetsAt: number; isUsingOverage: boolean }>
  /** per-session composer drafts, so any pane can push content into the chat */
  drafts: Record<string, string>
  /** per-session browser tabs — in the store so splits/remounts keep them */
  browserTabs: Record<string, { tabs: BrowserTab[]; activeId: string }>
  setBrowserTabs(sessionId: string, tabs: BrowserTab[], activeId: string): void
  /** Cursor-style context chips attached to the next message (file/line refs, selections) */
  attachments: Record<string, Attachment[]>
  /** per-session queue of messages submitted while the agent is running */
  messageQueue: Record<string, QueuedMessage[]>
  /** UI chrome */
  commandPaletteOpen: boolean
  fileFinderOpen: boolean
  settingsOpen: boolean
  /** when set, Settings opens focused on this category (e.g. 'settings.json') */
  settingsCategory: string | null
  sidebarVisible: boolean
  contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null
  /** click-to-enlarge overlay for a rendered attachment (image now, pdf-capable) */
  lightbox: { src: string; alt?: string; kind: 'image' | 'pdf' } | null
  openLightbox(src: string, kind: 'image' | 'pdf', alt?: string): void
  closeLightbox(): void
  /** promise-based prompt/confirm/save (Electron has no window.prompt/confirm) */
  dialog:
    | { kind: 'prompt'; title: string; initial: string; resolve: (v: string | null) => void }
    | { kind: 'confirm'; title: string; resolve: (v: boolean) => void }
    | { kind: 'save'; title: string; detail: string; resolve: (v: 'save' | 'dont' | 'cancel') => void }
    | null
  /** a file the focused session's Files panel should open (set by ⌘P) */
  fileToOpen: { sessionId: string; path: string; line?: number; nonce: number } | null
  diffToOpen: { sessionId: string; path: string; nonce: number } | null
  /** open the Diff panel in all-files review mode (the composer's "Changes N" pill) */
  reviewToOpen: { sessionId: string; nonce: number } | null
  openReviewFor(sessionId: string): void
  /** ⌘⇧F: open + focus the Search panel in the focused session's tile */
  searchToOpen: { sessionId: string; nonce: number } | null
  /** a URL the session's Browser panel should load (set by ⌘-click on links) */
  urlToOpen: { sessionId: string; url: string; nonce: number } | null
  requestOpenUrl(sessionId: string, url: string): void
  /** one-shot consume: the Browser pane opened the url; a pane remount must not
   *  replay it into a duplicate tab (the pane unmounts when you switch panels) */
  consumeUrlToOpen(nonce: number): void
  /** a browser keybinding main intercepted while the guest page had focus (⌘L/⌘T/⌘W/tab cycling) */
  browserHotkey: { sessionId: string; tabId: string; action: BrowserHotkeyAction; nonce: number } | null
  /** a nudge to surface a session's Browser context tab (agent-driven `goto`) */
  browserToShow: { sessionId: string; nonce: number } | null
  /** the agent-drivable browser (`hang4r browser goto`) with no live tab: load
   *  the EXACT url into the session's active/first tab (reusing an empty one) and
   *  surface the Browser context so the user sees it. No URL normalization — a
   *  data: URL must survive verbatim (unlike requestOpenUrl's ⌘-click path). */
  ensureBrowserTab(sessionId: string, url: string): void
  /** ⌃`: toggle the focused session's Terminal panel */
  terminalToToggle: { sessionId: string; nonce: number } | null
  /** open the Terminal panel and run a command in a fresh tab (slash workarounds) */
  terminalCommandToRun: { sessionId: string; command: string; label: string; nonce: number } | null
  toggleTerminalPanel(): void
  runInTerminal(sessionId: string, command: string, label: string): void
  /** one-shot consume: TerminalPanel took the command; a remount must not replay it */
  consumeTerminalCommand(nonce: number): void
  /** jump to the session's Subagents panel (the ⤷ button on agent rows in chat) */
  subagentsToOpen: { sessionId: string; nonce: number } | null
  openSubagents(sessionId: string): void
  /** ⌥⌘B: toggle the focused session's context panel (open → remembers tab
   *  and closes; closed → reopens the remembered tab, Files by default) */
  panelToToggle: { sessionId: string; nonce: number } | null
  togglePanel(): void
  /** Edit a sent message → rewind the conversation to it and resend (CC fork) */
  rewindAndResend(
    sessionId: string,
    originalText: string,
    occurrenceFromEnd: number,
    newText: string
  ): Promise<void>
  /** bumped after any git mutation (stage/revert/commit) so views re-read status */
  gitNonce: number
  bumpGit(): void
  /** the focused tile's active panel registers a "close top scope" fn for ⌘W */
  scopedClose: (() => boolean) | null
  setScopedClose(fn: (() => boolean) | null): void
  /** the Files panel registers a "new untitled file" fn for ⌘N (returns true if
   *  it handled the key, so App skips the global new-session dialog) */
  scopedNewFile: (() => boolean) | null
  setScopedNewFile(fn: (() => boolean) | null): void
  theme: Theme
  setTheme(theme: Theme): void
  /** Monaco font size (Settings → General) */
  editorFontSize: number
  setEditorFontSize(px: number): void
  /** conversation text size — applied as the --chat-font CSS var */
  chatFontSize: number
  setChatFontSize(px: number): void
  /** session ids pinned to the top of the sidebar (persisted) */
  pinnedSessionIds: string[]
  pinnedProjectIds: string[]
  projectSort: 'name' | 'recent'
  /** manual workspace order (project ids); overrides sort when set */
  projectOrder: string[]
  setProjectOrder(ids: string[]): void
  /** sidebar session filter text */
  sessionFilter: string

  init(): Promise<void>
  addProject(): Promise<void>
  removeProject(projectId: string): Promise<void>
  openNewSessionDialog(projectId: string): void
  closeNewSessionDialog(): void
  createSession(req: Parameters<typeof window.hang4r.createSession>[0]): Promise<void>
  /** Cursor's /best-of-n: same prompt, N (backend, model) variants, each in its own worktree pane */
  createBestOfN(
    projectId: string,
    variants: { backend: 'claude' | 'codex'; model?: string }[],
    permissionMode: Parameters<typeof window.hang4r.createSession>[0]['permissionMode'],
    firstPrompt: string
  ): Promise<void>
  openSession(sessionId: string, opts?: { split?: boolean }): Promise<void>
  /** Load a session's transcript if not already loaded; no-op if it is. */
  ensureTranscript(sessionId: string): Promise<void>
  closeTile(sessionId: string): void
  focusSession(sessionId: string): void
  sendPrompt(sessionId: string, text: string): Promise<void>
  /** Queue a message (with the current attachments) to auto-send when idle. */
  queueMessage(sessionId: string, text: string): void
  /** Drop a queued message by id (its × affordance). */
  removeQueuedMessage(sessionId: string, id: string): void
  /** Push a queued message through NOW: interrupt the turn, send it next. */
  sendQueuedNow(sessionId: string, id: string): Promise<void>
  /** Auto-send the next queued message; runs on each running→idle transition. */
  flushQueue(sessionId: string): Promise<void>
  sendReview(sessionId: string, comments: ReviewComment[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  setDraft(sessionId: string, text: string): void
  appendToDraft(sessionId: string, text: string): void
  addAttachment(sessionId: string, att: Attachment): void
  removeAttachment(sessionId: string, index: number): void
  renameSession(sessionId: string, title: string): Promise<void>
  /** Switch a session's permission mode; the CLI re-spawns with it on the next turn. */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
  respondPermission(sessionId: string, requestId: string, decision: string): Promise<void>
  respondQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
  duplicateSession(sessionId: string): Promise<void>
  retrySession(sessionId: string): Promise<void>
  toggleExpand(sessionId: string): void
  /** move or swap a session into the pane at targetIndex (drag & drop) */
  moveSessionToPane(sessionId: string, targetIndex: number): void
  /**
   * Drag & drop with Cursor-style edge zones: dropping on a pane's left/right/
   * top/bottom half splits it, inserting the session before/after the target;
   * dropping on the center moves/swaps (moveSessionToPane).
   */
  dropSessionOnPane(
    sessionId: string,
    targetIndex: number,
    zone: 'center' | 'left' | 'right' | 'top' | 'bottom'
  ): void
  toggleCommandPalette(open?: boolean): void
  toggleFileFinder(open?: boolean): void
  requestOpenFile(sessionId: string, path: string, line?: number): void
  openDiffFor(sessionId: string, path: string): void
  /** open the Search panel in the focused session (⌘⇧F); no-op if none focused */
  openSearch(): void
  setSettingsOpen(open: boolean): void
  openSettingsAt(category: string): void
  toggleSidebar(): void
  openContextMenu(x: number, y: number, items: ContextMenuItem[]): void
  closeContextMenu(): void
  togglePin(sessionId: string): void
  togglePinProject(projectId: string): void
  setProjectSort(sort: 'name' | 'recent'): void
  setSessionFilter(text: string): void
  archivedOpen: boolean
  setArchivedOpen(open: boolean): void
  cursorImportOpen: boolean
  setCursorImportOpen(open: boolean): void
  importSource: 'cursor' | 'claude' | 'codex' | 'cursorAgent'
  setImportSource(source: 'cursor' | 'claude' | 'codex' | 'cursorAgent'): void
  importExternalSession(
    source: 'cursor' | 'claude' | 'codex' | 'cursorAgent',
    id: string,
    name: string,
    projectId: string,
    cwd?: string
  ): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  showPrompt(title: string, initial?: string): Promise<string | null>
  showConfirm(title: string): Promise<boolean>
  showSave(title: string, detail: string): Promise<'save' | 'dont' | 'cancel'>
  resolveDialog(value: string | boolean | null): void
}

/** module-level: IPC subscriptions must be registered exactly once */
let subscribed = false

export const useHang4r = create<Hang4rState>((set, get) => ({
  projects: [],
  sessions: [],
  transcripts: {},
  openSessionIds: [],
  focusedSessionId: null,
  expandedSessionId: null,
  newSessionProjectId: null,
  usage: { inputTokens: 0, outputTokens: 0 },
  sessionUsage: {},
  sessionInit: {},
  rateLimits: {},
  drafts: {},
  browserTabs: {},
  attachments: {},
  messageQueue: {},
  commandPaletteOpen: false,
  fileFinderOpen: false,
  settingsOpen: false,
  settingsCategory: null,
  sidebarVisible: true,
  contextMenu: null,
  lightbox: null,
  dialog: null,
  fileToOpen: null,
  diffToOpen: null,
  reviewToOpen: null,
  searchToOpen: null,
  urlToOpen: null,
  browserHotkey: null,
  browserToShow: null,
  terminalToToggle: null,
  terminalCommandToRun: null,
  subagentsToOpen: null,
  panelToToggle: null,
  gitNonce: 0,
  pinnedSessionIds: [],
  pinnedProjectIds: [],
  projectSort: 'recent',
  projectOrder: [],
  setProjectOrder(ids) {
    set({ projectOrder: ids })
    void window.hang4r.setSetting('projectOrder', JSON.stringify(ids))
  },
  sessionFilter: '',
  archivedOpen: false,
  cursorImportOpen: false,
  importSource: 'cursor',

  async init() {
    const [projects, sessions, layoutJson] = await Promise.all([
      window.hang4r.listProjects(),
      window.hang4r.listSessions(),
      window.hang4r.getSetting('layout')
    ])
    set({ projects, sessions })

    // restore pinned sessions
    const pinnedJson = await window.hang4r.getSetting('pinnedSessions')
    if (pinnedJson) {
      try {
        set({ pinnedSessionIds: JSON.parse(pinnedJson) })
      } catch {
        /* ignore */
      }
    }
    // restore pinned workspaces + sort
    const pinnedProjJson = await window.hang4r.getSetting('pinnedProjects')
    if (pinnedProjJson) {
      try {
        set({ pinnedProjectIds: JSON.parse(pinnedProjJson) })
      } catch {
        /* ignore */
      }
    }
    const sort = await window.hang4r.getSetting('projectSort')
    if (sort === 'name' || sort === 'recent') set({ projectSort: sort })
    const orderJson = await window.hang4r.getSetting('projectOrder')
    if (orderJson) {
      try {
        const ids = JSON.parse(orderJson)
        if (Array.isArray(ids)) set({ projectOrder: ids })
      } catch {
        /* ignore */
      }
    }
    // restore + apply the theme (system follows the OS preference)
    const savedTheme = (await window.hang4r.getSetting('theme')) as Theme | null
    const theme: Theme = savedTheme ?? 'system'
    applyTheme(theme)
    set({ theme })

    // restore font sizes (editor = Monaco, chat = conversation text)
    const savedEditorFont = Number(await window.hang4r.getSetting('editorFontSize'))
    if (Number.isFinite(savedEditorFont) && savedEditorFont >= 9 && savedEditorFont <= 24) {
      document.documentElement.style.setProperty('--editor-font', `${savedEditorFont}px`)
      set({ editorFontSize: savedEditorFont })
    }
    const savedChatFont = Number(await window.hang4r.getSetting('chatFontSize'))
    if (Number.isFinite(savedChatFont) && savedChatFont >= 9 && savedChatFont <= 24) {
      document.documentElement.style.setProperty('--chat-font', `${savedChatFont}px`)
      set({ chatFontSize: savedChatFont })
    }

    // restore the tiled layout (open panes + focus) from the last run
    if (layoutJson) {
      try {
        const layout = JSON.parse(layoutJson) as { open: string[]; focused: string | null }
        const alive = layout.open.filter((id) => sessions.some((s) => s.id === id))
        for (const id of alive) await get().openSession(id, { split: true })
        if (layout.focused && alive.includes(layout.focused)) {
          set({ focusedSessionId: layout.focused })
        }
      } catch {
        // corrupt layout — start clean
      }
    }

    // React StrictMode double-mounts App; without this guard we'd subscribe to
    // IPC twice and apply every agent event twice (dup bubbles, dup rows).
    if (subscribed) return
    subscribed = true

    // External edits to ~/.hang4r/settings.json (or a workspace's) live-reload:
    // re-read the display settings the app applies at boot and re-apply them.
    window.hang4r.onSettingsChanged(() => {
      void (async (): Promise<void> => {
        const t = (await window.hang4r.getSetting('theme')) as Theme | null
        const theme: Theme = t ?? 'system'
        applyTheme(theme)
        set({ theme })
        const ef = Number(await window.hang4r.getSetting('editorFontSize'))
        if (Number.isFinite(ef) && ef >= 9 && ef <= 24) {
          document.documentElement.style.setProperty('--editor-font', `${ef}px`)
          set({ editorFontSize: ef })
        }
        const cf = Number(await window.hang4r.getSetting('chatFontSize'))
        if (Number.isFinite(cf) && cf >= 9 && cf <= 24) {
          document.documentElement.style.setProperty('--chat-font', `${cf}px`)
          set({ chatFontSize: cf })
        }
      })()
    })

    window.hang4r.onAgentEvent((ev: SessionEvent) => {
      set((state) => {
        const patch: Partial<Hang4rState> = {}

        // Usage tracking applies to ALL sessions, open or not.
        if (ev.event.kind === 'turn-complete') {
          const inTok = ev.event.inputTokens ?? 0
          const outTok = ev.event.outputTokens ?? 0
          // real context occupancy includes cached tokens; fall back to input
          const ctxTok = ev.event.contextTokens ?? inTok
          patch.usage = {
            inputTokens: state.usage.inputTokens + inTok,
            outputTokens: state.usage.outputTokens + outTok
          }
          const prev = state.sessionUsage[ev.sessionId] ?? {
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: 0
          }
          patch.sessionUsage = {
            ...state.sessionUsage,
            [ev.sessionId]: {
              inputTokens: prev.inputTokens + inTok,
              outputTokens: prev.outputTokens + outTok,
              contextTokens: ctxTok || prev.contextTokens, // last turn's context size
              contextWindowTokens: ev.event.contextWindowTokens ?? prev.contextWindowTokens
            }
          }
        } else if (ev.event.kind === 'usage') {
          // live mid-turn context size → gauge fills in while the agent works
          const ctxTok = ev.event.contextTokens ?? 0
          if (ctxTok > 0) {
            const prev = state.sessionUsage[ev.sessionId] ?? {
              inputTokens: 0,
              outputTokens: 0,
              contextTokens: 0
            }
            patch.sessionUsage = {
              ...state.sessionUsage,
              [ev.sessionId]: {
                ...prev,
                contextTokens: ctxTok,
                contextWindowTokens: ev.event.contextWindowTokens ?? prev.contextWindowTokens
              }
            }
          }
        } else if (ev.event.kind === 'init') {
          patch.sessionInit = {
            ...state.sessionInit,
            [ev.sessionId]: {
              model: ev.event.model,
              version: ev.event.version,
              tools: ev.event.tools,
              skills: ev.event.skills,
              slashCommands: ev.event.slashCommands,
              mcpServers: ev.event.mcpServers,
              plugins: ev.event.plugins
            }
          }
        } else if (ev.event.kind === 'rate-limit') {
          patch.rateLimits = {
            ...state.rateLimits,
            [ev.event.rateLimitType]: {
              status: ev.event.status,
              resetsAt: ev.event.resetsAt,
              isUsingOverage: ev.event.isUsingOverage
            }
          }
        }

        // Transcript apply only for open sessions; seq-dedupe so a live event
        // already included in a persisted replay can never double-apply.
        const existing = state.transcripts[ev.sessionId]
        if (existing && ev.seq > existing.lastSeq) {
          const t: Transcript = {
            items: [...existing.items],
            blockIndex: existing.blockIndex,
            toolIndex: existing.toolIndex,
            hooks: [...existing.hooks],
            lastSeq: ev.seq
          }
          applyEvent(t, ev.event)
          patch.transcripts = { ...state.transcripts, [ev.sessionId]: t }
        }
        return patch
      })
    })

    window.hang4r.onSessionUpdated((session) => {
      const prev = get().sessions.find((s) => s.id === session.id)
      const wasActive = !!prev && (prev.status === 'running' || prev.status === 'starting')
      set((state) => {
        const idx = state.sessions.findIndex((s) => s.id === session.id)
        const sessions =
          idx === -1
            ? [...state.sessions, session]
            : state.sessions.map((s) => (s.id === session.id ? session : s))
        return { sessions }
      })
      // turn just settled (running/starting → idle|error): auto-send the next
      // queued message. We flush on 'error' too because a send-now interrupt
      // makes the real claude CLI emit an is_error result (status → 'error'),
      // and the queued message is explicit user intent that should still go.
      if (wasActive && (session.status === 'idle' || session.status === 'error')) {
        void get().flushQueue(session.id)
      }
    })

    // clicked a completion notification → bring that session front & center
    window.hang4r.onFocusSession((sessionId) => {
      void get().openSession(sessionId)
    })

    // the agent-drivable browser (`hang4r browser goto`) with no live tab: load
    // the exact url into the session's Browser pane and surface the Browser
    // context so the user SEES what the agent is doing. If the session's tile
    // isn't on screen, ensureBrowserTab OPENS it (as a split tile) so a webview
    // actually mounts — an agent must be able to cold-open + drive the browser
    // like cmux, not get an "open the Browser tab first" error (Angel).
    window.hang4r.onBrowserEnsureTab(({ sessionId, url }) => {
      get().ensureBrowserTab(sessionId, url)
    })

    // browser keybinding pressed while the guest page had focus — main
    // intercepted it; the session's BrowserPane consumes and acts
    window.hang4r.onBrowserHotkey(({ sessionId, tabId, action }) => {
      set((s) => ({
        browserHotkey: { sessionId, tabId, action, nonce: (s.browserHotkey?.nonce ?? 0) + 1 }
      }))
    })

    // a link inside the browser guest asked for a new window (⌘-click /
    // target=_blank) — main denied the OS window and routed the url here;
    // open it as a new in-pane tab (same path as ⌘-clicks elsewhere)
    window.hang4r.onBrowserOpenUrl(({ sessionId, url }) => {
      get().requestOpenUrl(sessionId, url)
    })

    // Returning to hang4r after driving a conversation elsewhere (Remote Control
    // on your phone, or a `/remote-control` terminal) — pull in any turns taken
    // in that external CLI so the desktop view catches up instead of showing a
    // stale, "forked"-looking transcript (Angel). resyncSession is a cheap no-op
    // when there are no external turns / the session is mid-turn; imported turns
    // broadcast as external-turn events and land in the live transcript.
    window.addEventListener('focus', () => {
      for (const id of get().openSessionIds) void window.hang4r.resyncSession(id).catch(() => {})
    })
  },

  async removeProject(projectId) {
    await window.hang4r.removeProject(projectId)
    const [projects, sessions] = await Promise.all([
      window.hang4r.listProjects(),
      window.hang4r.listSessions()
    ])
    set((s) => ({
      projects,
      sessions,
      pinnedProjectIds: s.pinnedProjectIds.filter((id) => id !== projectId),
      newSessionProjectId: s.newSessionProjectId === projectId ? null : s.newSessionProjectId
    }))
  },
  async addProject() {
    const path = await window.hang4r.pickProjectFolder()
    if (!path) return
    const project = await window.hang4r.createProject(path)
    // just register the workspace — don't force the New Agent dialog. A session
    // (with its prompt) is created explicitly via New Agent / the workspace's +.
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id)
        ? s.projects
        : [...s.projects, project]
    }))
  },

  openNewSessionDialog(projectId) {
    set({ newSessionProjectId: projectId })
  },
  closeNewSessionDialog() {
    set({ newSessionProjectId: null })
  },

  async createSession(req) {
    const session = await window.hang4r.createSession(req)
    set((s) => ({
      // the main-process broadcast may have already appended it — merge, never dup
      sessions: s.sessions.some((x) => x.id === session.id)
        ? s.sessions.map((x) => (x.id === session.id ? session : x))
        : [...s.sessions, session],
      newSessionProjectId: null
    }))
    // a fresh agent opens SINGLE (Cursor): it takes over the workspace as the
    // sole pane. Side-by-side is opt-in via drag-to-split / ⌘-click / Best-of-N.
    await get().openSession(session.id)
  },

  async createBestOfN(projectId, variants, permissionMode, firstPrompt) {
    for (const v of variants.slice(0, 4)) {
      const session = await window.hang4r.createSession({
        projectId,
        backend: v.backend,
        environment: 'worktree',
        model: v.model || undefined,
        permissionMode,
        title: `${firstPrompt.slice(0, 40)} [${v.backend}${v.model ? '/' + v.model : ''}]`,
        firstPrompt
      })
      set((s) => ({
        sessions: s.sessions.some((x) => x.id === session.id)
          ? s.sessions.map((x) => (x.id === session.id ? session : x))
          : [...s.sessions, session]
      }))
      await get().openSession(session.id, { split: true })
    }
    set({ newSessionProjectId: null })
  },

  async openSession(sessionId, opts) {
    const loaded = await loadTranscriptData(sessionId)
    // seed this session's persisted UI (open files + active panel) into the
    // component memos BEFORE the tile mounts, so it restores after a restart /
    // reload. seedSessionUi only fills EMPTY memos, so a session that's already
    // open keeps its live state.
    try {
      const raw = await window.hang4r.getSetting(`sessionUi:${sessionId}`)
      if (raw) seedSessionUi(sessionId, JSON.parse(raw))
    } catch {
      /* best-effort restore */
    }
    set((s) => {
      let openSessionIds = s.openSessionIds
      if (opts?.split) {
        // open in a new pane (Best-of-N, duplicate, ⌘-click, layout restore),
        // capped at 4 tiles. Side-by-side splits are always explicit now.
        if (!openSessionIds.includes(sessionId)) {
          openSessionIds = [...openSessionIds.slice(-3), sessionId]
        }
      } else {
        // single-open (Cursor default): the chosen session becomes the sole
        // pane — clicking/creating/importing shows it alone, never auto-splits.
        openSessionIds = [sessionId]
      }
      return {
        transcripts: { ...s.transcripts, [sessionId]: loaded.transcript },
        openSessionIds,
        focusedSessionId: sessionId,
        sessionUsage: {
          ...s.sessionUsage,
          [sessionId]: {
            inputTokens: loaded.inputTokens,
            outputTokens: loaded.outputTokens,
            contextTokens: loaded.contextTokens,
            contextWindowTokens: loaded.contextWindowTokens
          }
        }
      }
    })
    persistLayout(get())
  },

  /**
   * Load a session's transcript if it isn't loaded yet — a no-op otherwise.
   * Used when a session lands in a pane without going through openSession
   * (e.g. drag-dropped onto a split from the sidebar), so the pane isn't left
   * blank until the user opens that session normally elsewhere.
   */
  async ensureTranscript(sessionId) {
    if (get().transcripts[sessionId]) return
    const loaded = await loadTranscriptData(sessionId)
    set((s) => ({
      transcripts: { ...s.transcripts, [sessionId]: loaded.transcript },
      sessionUsage: {
        ...s.sessionUsage,
        [sessionId]: {
          inputTokens: loaded.inputTokens,
          outputTokens: loaded.outputTokens,
          contextTokens: loaded.contextTokens,
          contextWindowTokens: loaded.contextWindowTokens
        }
      }
    }))
  },

  closeTile(sessionId) {
    set((s) => ({
      openSessionIds: s.openSessionIds.filter((id) => id !== sessionId),
      focusedSessionId:
        s.focusedSessionId === sessionId
          ? (s.openSessionIds.find((id) => id !== sessionId) ?? null)
          : s.focusedSessionId
    }))
    persistLayout(get())
  },

  focusSession(sessionId) {
    set({ focusedSessionId: sessionId })
    persistLayout(get())
  },

  async sendPrompt(sessionId, text) {
    // text chips → prepended into the prompt; image chips → sent as image
    // content blocks the agent actually sees. Clear all after send.
    const atts = get().attachments[sessionId] ?? []
    const { full, images } = composeMessage(text, atts)
    if (atts.length > 0) set((s) => ({ attachments: { ...s.attachments, [sessionId]: [] } }))
    await window.hang4r.prompt(sessionId, full, images.length ? images : undefined)
  },

  queueMessage(sessionId, text) {
    // snapshot the current attachments WITH the message so images survive the
    // wait, then clear the composer's attachments (same as an immediate send)
    const atts = get().attachments[sessionId] ?? []
    const msg: QueuedMessage = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      attachments: atts
    }
    set((s) => ({
      messageQueue: {
        ...s.messageQueue,
        [sessionId]: [...(s.messageQueue[sessionId] ?? []), msg]
      },
      attachments: atts.length > 0 ? { ...s.attachments, [sessionId]: [] } : s.attachments
    }))
  },

  removeQueuedMessage(sessionId, id) {
    set((s) => ({
      messageQueue: {
        ...s.messageQueue,
        [sessionId]: (s.messageQueue[sessionId] ?? []).filter((m) => m.id !== id)
      }
    }))
  },

  async sendQueuedNow(sessionId, id) {
    const q = get().messageQueue[sessionId] ?? []
    const target = q.find((m) => m.id === id)
    if (!target) return
    // move it to the front so the next idle transition flushes THIS one first
    set((s) => ({
      messageQueue: {
        ...s.messageQueue,
        [sessionId]: [target, ...(s.messageQueue[sessionId] ?? []).filter((m) => m.id !== id)]
      }
    }))
    const session = get().sessions.find((x) => x.id === sessionId)
    const running = session?.status === 'running' || session?.status === 'starting'
    if (running) {
      // interrupt the current turn; the interrupted turn emits turn-complete
      // (idle, or 'error' for claude's error_during_execution abort) →
      // onSessionUpdated flushes this message as the next prompt. We do NOT
      // prompt while still running — that would race the live turn.
      await get().interrupt(sessionId)
    } else {
      // already idle (rare race) — send it straight away
      await get().flushQueue(sessionId)
    }
  },

  async flushQueue(sessionId) {
    const q = get().messageQueue[sessionId] ?? []
    if (q.length === 0) return
    const [next, ...rest] = q
    set((s) => ({ messageQueue: { ...s.messageQueue, [sessionId]: rest } }))
    const { full, images } = composeMessage(next.text, next.attachments)
    await window.hang4r.prompt(sessionId, full, images.length ? images : undefined)
  },

  addAttachment(sessionId, att) {
    set((s) => ({
      attachments: {
        ...s.attachments,
        [sessionId]: [...(s.attachments[sessionId] ?? []), att]
      }
    }))
  },

  removeAttachment(sessionId, index) {
    set((s) => ({
      attachments: {
        ...s.attachments,
        [sessionId]: (s.attachments[sessionId] ?? []).filter((_, i) => i !== index)
      }
    }))
  },

  toggleCommandPalette(open) {
    set((s) => ({ commandPaletteOpen: open ?? !s.commandPaletteOpen }))
  },
  toggleFileFinder(open) {
    set((s) => ({ fileFinderOpen: open ?? !s.fileFinderOpen }))
  },
  requestOpenFile(sessionId, path, line) {
    set({ fileToOpen: { sessionId, path, line, nonce: (get().fileToOpen?.nonce ?? 0) + 1 } })
  },
  requestOpenUrl(sessionId, url) {
    set({ urlToOpen: { sessionId, url, nonce: (get().urlToOpen?.nonce ?? 0) + 1 } })
  },
  consumeUrlToOpen(nonce) {
    if (get().urlToOpen?.nonce === nonce) set({ urlToOpen: null })
  },
  toggleTerminalPanel() {
    const sessionId = get().focusedSessionId
    if (!sessionId) return
    set({ terminalToToggle: { sessionId, nonce: (get().terminalToToggle?.nonce ?? 0) + 1 } })
  },
  runInTerminal(sessionId, command, label) {
    set({
      terminalCommandToRun: {
        sessionId,
        command,
        label,
        nonce: (get().terminalCommandToRun?.nonce ?? 0) + 1
      }
    })
  },
  consumeTerminalCommand(nonce) {
    if (get().terminalCommandToRun?.nonce === nonce) set({ terminalCommandToRun: null })
  },
  openSubagents(sessionId) {
    set({ subagentsToOpen: { sessionId, nonce: (get().subagentsToOpen?.nonce ?? 0) + 1 } })
  },
  togglePanel() {
    const sessionId = get().focusedSessionId
    if (!sessionId) return
    set({ panelToToggle: { sessionId, nonce: (get().panelToToggle?.nonce ?? 0) + 1 } })
  },
  async rewindAndResend(sessionId, originalText, occurrenceFromEnd, newText) {
    await window.hang4r.rewindSession(sessionId, originalText, occurrenceFromEnd, newText)
    // main truncated the persisted events and re-prompted — rebuild the
    // transcript from what remains (same replay openSession does)
    const events = await window.hang4r.getSessionEvents(sessionId)
    const t = emptyTranscript()
    for (const e of events) {
      applyEvent(t, e.event)
      t.lastSeq = Math.max(t.lastSeq, e.seq)
    }
    set((s) => ({ transcripts: { ...s.transcripts, [sessionId]: t } }))
  },
  openSearch() {
    const sessionId = get().focusedSessionId
    if (!sessionId) return
    set({ searchToOpen: { sessionId, nonce: (get().searchToOpen?.nonce ?? 0) + 1 } })
  },
  bumpGit() {
    set({ gitNonce: get().gitNonce + 1 })
  },
  scopedClose: null,
  setScopedClose(fn) {
    set({ scopedClose: fn })
  },
  scopedNewFile: null,
  setScopedNewFile(fn) {
    set({ scopedNewFile: fn })
  },
  theme: 'system',
  setTheme(theme) {
    applyTheme(theme)
    void window.hang4r.setSetting('theme', theme)
    set({ theme })
  },
  editorFontSize: 12,
  setEditorFontSize(px) {
    const size = Math.min(24, Math.max(9, Math.round(px)))
    // Monaco reads the number; rendered md preview + file tree follow the var
    document.documentElement.style.setProperty('--editor-font', `${size}px`)
    void window.hang4r.setSetting('editorFontSize', String(size))
    set({ editorFontSize: size })
  },
  chatFontSize: 13,
  setChatFontSize(px) {
    const size = Math.min(24, Math.max(9, Math.round(px)))
    document.documentElement.style.setProperty('--chat-font', `${size}px`)
    void window.hang4r.setSetting('chatFontSize', String(size))
    set({ chatFontSize: size })
  },
  openDiffFor(sessionId, path) {
    set({ diffToOpen: { sessionId, path, nonce: (get().diffToOpen?.nonce ?? 0) + 1 } })
  },
  openReviewFor(sessionId) {
    set({ reviewToOpen: { sessionId, nonce: (get().reviewToOpen?.nonce ?? 0) + 1 } })
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open, settingsCategory: open ? get().settingsCategory : null })
  },
  openSettingsAt(category) {
    set({ settingsOpen: true, settingsCategory: category })
  },
  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }))
  },
  openContextMenu(x, y, items) {
    set({ contextMenu: { x, y, items } })
  },
  closeContextMenu() {
    set({ contextMenu: null })
  },
  openLightbox(src, kind, alt) {
    set({ lightbox: { src, kind, alt } })
  },
  closeLightbox() {
    set({ lightbox: null })
  },
  togglePin(sessionId) {
    set((s) => {
      const pinned = s.pinnedSessionIds.includes(sessionId)
        ? s.pinnedSessionIds.filter((id) => id !== sessionId)
        : [...s.pinnedSessionIds, sessionId]
      void window.hang4r.setSetting('pinnedSessions', JSON.stringify(pinned))
      return { pinnedSessionIds: pinned }
    })
  },
  togglePinProject(projectId) {
    set((s) => {
      const pinned = s.pinnedProjectIds.includes(projectId)
        ? s.pinnedProjectIds.filter((id) => id !== projectId)
        : [...s.pinnedProjectIds, projectId]
      void window.hang4r.setSetting('pinnedProjects', JSON.stringify(pinned))
      return { pinnedProjectIds: pinned }
    })
  },
  setProjectSort(sort) {
    void window.hang4r.setSetting('projectSort', sort)
    set({ projectSort: sort })
  },
  setSessionFilter(text) {
    set({ sessionFilter: text })
  },
  setArchivedOpen(open) {
    set({ archivedOpen: open })
  },
  setCursorImportOpen(open) {
    set({ cursorImportOpen: open })
  },
  setImportSource(source) {
    set({ importSource: source })
  },
  async importExternalSession(source, id, name, projectId, cwd) {
    let session: SessionMeta
    if (source === 'claude') {
      // same engine → TRUE resume in the original cwd (continues where it left
      // off, and lands in the right workspace automatically).
      session = await window.hang4r.resumeClaudeSession(id, cwd, name)
    } else if (source === 'codex') {
      session = await window.hang4r.resumeCodexSession(id, cwd, name)
    } else if (source === 'cursorAgent') {
      // same engine → TRUE resume via cursor-agent --resume <chatId>
      session = await window.hang4r.resumeCursorAgentSession(id, cwd, name)
    } else {
      // Cursor is a different engine — seed a new Claude session with the
      // transcript as context (can't resume Cursor's engine).
      const msgs = await window.hang4r.cursorTranscript(id)
      const transcript = msgs
        .map((m) => `**${m.role === 'user' ? 'User' : 'Assistant'}:** ${m.text}`)
        .join('\n\n')
        .slice(0, 16000)
      const seed =
        `This conversation was imported from a Cursor session ("${name}"). ` +
        `Read it for context and continue from where it left off.\n\n---\n${transcript}\n---`
      session = await window.hang4r.createSession({
        projectId,
        backend: 'claude',
        environment: 'worktree',
        permissionMode: 'acceptEdits',
        title: `↳ ${name}`,
        firstPrompt: seed
      })
    }
    set({ cursorImportOpen: false })
    const [projects, list] = await Promise.all([
      window.hang4r.listProjects(),
      window.hang4r.listSessions()
    ])
    set({ projects, sessions: list })
    await get().openSession(session.id)
  },
  async unarchiveSession(sessionId) {
    const restored = await window.hang4r.unarchiveSession(sessionId)
    if (restored) {
      set((s) => ({
        sessions: s.sessions.some((x) => x.id === restored.id)
          ? s.sessions.map((x) => (x.id === restored.id ? restored : x))
          : [...s.sessions, restored]
      }))
      await get().openSession(sessionId)
    }
  },
  showPrompt(title, initial = '') {
    return new Promise((resolve) => set({ dialog: { kind: 'prompt', title, initial, resolve } }))
  },
  showConfirm(title) {
    return new Promise((resolve) => set({ dialog: { kind: 'confirm', title, resolve } }))
  },
  showSave(title, detail) {
    return new Promise((resolve) => set({ dialog: { kind: 'save', title, detail, resolve } }))
  },
  resolveDialog(value) {
    const d = get().dialog
    if (!d) return
    set({ dialog: null })
    if (d.kind === 'prompt') d.resolve(typeof value === 'string' ? value : null)
    else if (d.kind === 'save') d.resolve((value as 'save' | 'dont' | 'cancel') ?? 'cancel')
    else d.resolve(value === true)
  },

  async sendReview(sessionId, comments) {
    await window.hang4r.submitReview(sessionId, comments)
  },

  async interrupt(sessionId) {
    await window.hang4r.interrupt(sessionId)
  },

  async archiveSession(sessionId) {
    // warn if the session has uncommitted changes (its worktree gets removed)
    const changed = await window.hang4r.getChangedFiles(sessionId).catch(() => [])
    if (changed.length > 0) {
      const ok = await get().showConfirm(
        `This session has ${changed.length} uncommitted change${changed.length > 1 ? 's' : ''}. ` +
          `Archive anyway? Its worktree will be removed.`
      )
      if (!ok) return
    }
    await window.hang4r.archiveSession(sessionId)
    // its worktree is gone — drop the per-session UI memos (view state, tab
    // layout, dirty flags) held in component modules
    forgetSessionUiState(sessionId)
    set((s) => {
      const { [sessionId]: _drop, ...messageQueue } = s.messageQueue
      return {
        sessions: s.sessions.filter((x) => x.id !== sessionId),
        openSessionIds: s.openSessionIds.filter((id) => id !== sessionId),
        messageQueue
      }
    })
  },

  setDraft(sessionId, text) {
    set((s) => ({ drafts: { ...s.drafts, [sessionId]: text } }))
  },

  setBrowserTabs(sessionId, tabs, activeId) {
    set((s) => ({ browserTabs: { ...s.browserTabs, [sessionId]: { tabs, activeId } } }))
  },

  ensureBrowserTab(sessionId, url) {
    // Load the exact url into the session's active/first tab (reusing an empty
    // one) via the webview's own src navigation — verbatim, no normalization (a
    // data: URL must survive, unlike requestOpenUrl's ⌘-click path). main's
    // browserControlService waits for this navigation to settle, then reports.
    const cur = get().browserTabs[sessionId]
    const tabs = cur?.tabs ?? []
    const target = tabs.find((t) => t.id === cur?.activeId) ?? tabs[0]
    const patch: Partial<BrowserTab> = { url, current: url, tunneledPort: null }
    if (!target) {
      const t: BrowserTab = { id: `bt-${Date.now().toString(36)}-ensure`, ...patch } as BrowserTab
      get().setBrowserTabs(sessionId, [...tabs, t], t.id)
    } else {
      const nextTabs = tabs.map((t) => (t.id === target.id ? { ...t, ...patch } : t))
      get().setBrowserTabs(sessionId, nextTabs, target.id)
    }
    // Surface the Browser context tab. If the session's tile isn't on screen,
    // OPEN it first — otherwise no BrowserPane mounts, no guest webContents ever
    // registers, and an agent's `hang4r browser goto` just times out ("open the
    // Browser tab first"). An agent must be able to COLD-OPEN and drive the
    // browser so the user SEES it work (like cmux), instead of the CLI erroring
    // whenever the pane happens to be closed. openSession is async (loads the
    // transcript + mounts the tile), so surface Browser only once it's open. We
    // add it as a split tile rather than collapsing the user's current view.
    const surface = (): void =>
      set((s) => ({ browserToShow: { sessionId, nonce: (s.browserToShow?.nonce ?? 0) + 1 } }))
    if (get().openSessionIds.includes(sessionId)) surface()
    else void get().openSession(sessionId, { split: true }).then(surface)
  },

  appendToDraft(sessionId, text) {
    set((s) => {
      const cur = s.drafts[sessionId] ?? ''
      return { drafts: { ...s.drafts, [sessionId]: cur ? cur + '\n' + text : text } }
    })
  },

  async respondPermission(sessionId, requestId, decision) {
    await window.hang4r.respondPermission(sessionId, requestId, decision)
  },

  async respondQuestion(sessionId, requestId, answers) {
    await window.hang4r.respondQuestion(sessionId, requestId, answers)
  },

  async duplicateSession(sessionId) {
    const dup = await window.hang4r.duplicateSession(sessionId)
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === dup.id)
        ? s.sessions
        : [...s.sessions, dup]
    }))
    await get().openSession(dup.id, { split: true })
  },

  async retrySession(sessionId) {
    await window.hang4r.retrySession(sessionId)
  },

  toggleExpand(sessionId) {
    set((s) => ({
      expandedSessionId: s.expandedSessionId === sessionId ? null : sessionId,
      focusedSessionId: sessionId
    }))
  },

  async renameSession(sessionId, title) {
    await window.hang4r.renameSession(sessionId, title)
    // session-updated broadcast refreshes the list; update eagerly too
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, title } : x))
    }))
  },

  async setSessionPermissionMode(sessionId, mode) {
    // session-updated broadcast refreshes the footer; update eagerly too
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, permissionMode: mode } : x))
    }))
    await window.hang4r.setSessionPermissionMode(sessionId, mode)
  },

  moveSessionToPane(sessionId, targetIndex) {
    set((s) => {
      const open = [...s.openSessionIds]
      const from = open.indexOf(sessionId)
      if (targetIndex >= open.length) {
        // drop on empty space: append as a new pane (≤4)
        if (from !== -1) open.splice(from, 1)
        open.push(sessionId)
        return { openSessionIds: open.slice(-4), focusedSessionId: sessionId }
      }
      if (from === -1) {
        // not open yet: take over the target pane
        open[targetIndex] = sessionId
      } else if (from !== targetIndex) {
        // swap panes
        ;[open[from], open[targetIndex]] = [open[targetIndex], open[from]]
      }
      return { openSessionIds: open, focusedSessionId: sessionId }
    })
    persistLayout(get())
  },

  dropSessionOnPane(sessionId, targetIndex, zone) {
    // a session dropped straight into a pane never went through openSession,
    // so its transcript may never have been loaded — fetch it now (no-op if
    // it's already open elsewhere) or the new/split pane renders blank
    void get()
      .ensureTranscript(sessionId)
      .catch(() => {
        /* non-fatal — pane just stays blank if this fails, same as before */
      })
    // a drop while a pane is EXPANDED must exit expand mode — the new split
    // was otherwise created invisibly behind the expanded pane (Angel's call,
    // Jul 15: auto-un-expand so you see what you just did)
    if (get().expandedSessionId) set({ expandedSessionId: null })
    // center = plain move/swap (keeps the existing tile-header behavior)
    if (zone === 'center') {
      get().moveSessionToPane(sessionId, targetIndex)
      return
    }
    // dropping a pane onto its OWN edge is a no-op, not a reorder (Angel's
    // call, Jul 15) — reordering needs a drop somewhere else
    if (get().openSessionIds[targetIndex] === sessionId) return
    set((s) => {
      const open = [...s.openSessionIds]
      const targetId = open[targetIndex]
      const from = open.indexOf(sessionId)
      // dropped on empty space (no pane there) → append as a new pane (≤4)
      if (!targetId) {
        if (from !== -1) open.splice(from, 1)
        open.push(sessionId)
        return { openSessionIds: open.slice(-4), focusedSessionId: sessionId }
      }
      // remove any existing occurrence first so a re-order lands cleanly
      if (from !== -1) open.splice(from, 1)
      // a brand-new session at the 4-pane cap can't add a 5th → take the target pane
      if (from === -1 && open.length >= 4) {
        const ti = open.indexOf(targetId)
        open[ti === -1 ? open.length - 1 : ti] = sessionId
        return { openSessionIds: open, focusedSessionId: sessionId }
      }
      // insert before (left/top) or after (right/bottom) the target session
      let ti = open.indexOf(targetId)
      if (ti === -1) ti = open.length
      const after = zone === 'right' || zone === 'bottom'
      open.splice(after ? ti + 1 : ti, 0, sessionId)
      return { openSessionIds: open.slice(0, 4), focusedSessionId: sessionId }
    })
    persistLayout(get())
  }
}))

/** persist open panes + focus so the tiled layout survives restarts */
function persistLayout(s: Hang4rState): void {
  void window.hang4r.setSetting(
    'layout',
    JSON.stringify({ open: s.openSessionIds, focused: s.focusedSessionId })
  )
}
