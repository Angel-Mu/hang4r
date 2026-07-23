/**
 * Shared domain + agent event protocol, used by main and renderer.
 * The AgentEvent model is our internal, ACP-shaped protocol: every backend
 * adapter (Claude Code, Codex, ...) translates its native stream into this.
 */

export type BackendId = 'claude' | 'codex' | 'cursor'

export type EnvironmentKind = 'local' | 'worktree' | 'ssh'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface ModelChoice {
  value: string
  label: string
  contextWindowTokens?: number
}

export interface UsageWindow {
  label: string
  pct: number
  resets: string
}

export interface ClaudeUsageSnapshot {
  windows: UsageWindow[]
  fetchedAt: number
  stale?: boolean
}

export interface CodexUsageSnapshot {
  windows: UsageWindow[]
  fetchedAt: number
  stale?: boolean
  planType?: string | null
  lifetimeTokens?: number
  resetCredits?: number
}

/**
 * Cursor CLI exposes no quota/usage-window endpoint (verified against
 * `cursor-agent about` / `status --format json`) — this is deliberately
 * thinner than the other snapshots. No `windows` field: don't fabricate one.
 */
export interface CursorUsageSnapshot {
  tier: string | null
  email: string | null
  model: string | null
  fetchedAt: number
  stale?: boolean
}

export type SessionStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'error'
  | 'archived'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
}

export interface SessionMeta {
  id: string
  projectId: string
  backend: BackendId
  title: string
  status: SessionStatus
  /** The backend's own session id (Claude session_id) — used for --resume */
  backendSessionId: string | null
  model: string | null
  /** Working directory the agent runs in (repo path, or a worktree path) */
  cwd: string
  environment: EnvironmentKind
  /** Diff base: branch tip for worktrees, or 'HEAD' for local sessions */
  baseRef: string
  permissionMode: PermissionMode
  /** ssh sessions: id into the sshHosts setting; cwd is the REMOTE path */
  remoteHostId: string | null
  createdAt: number
  updatedAt: number
  totalCostUsd: number
  lastError: string | null
}

/* ---------------- Diff & review ---------------- */

/** An image sent along with a prompt (base64, no data: prefix). */
export interface PromptImage {
  base64: string
  mediaType: string
}

/** A composer attachment: a text context chip and/or an image. */
export interface Attachment {
  label: string
  text?: string
  image?: { base64: string; mediaType: string }
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

/**
 * A review scope for the Diff panel's scope dropdown (Cursor-style). Each scope
 * is a different git comparison:
 * - `lastTurn`   — HEAD~1..working tree (worktree per-turn checkpoints)
 * - `uncommitted`— baseRef vs working tree (all pending work; = the pill count)
 * - `unstaged`   — working tree vs index
 * - `staged`     — index vs HEAD
 * - `branch`     — baseRef...HEAD (committed changes on the session branch)
 */
export type DiffScope = 'lastTurn' | 'uncommitted' | 'unstaged' | 'staged' | 'branch'

/** The changed files for a scope plus the scope's aggregate add/del totals. */
export interface ScopedFiles {
  files: ChangedFile[]
  adds: number
  dels: number
}

/** One entry in the scope dropdown: its file count and whether it applies here. */
export interface ScopeSummary {
  scope: DiffScope
  count: number
  available: boolean
}

export interface ReviewComment {
  /** file path the comment is anchored to */
  path: string
  /** 1-based line number in the new version of the file */
  line: number
  body: string
  /**
   * Which side of the diff the comment is anchored to. 'new' (the default) is
   * an added/context line in the new file; 'old' is a DELETED line (`line` is
   * the old-file line number); 'file' is a whole-file comment (`line` is 0).
   */
  anchor?: 'new' | 'old' | 'file'
}

/** One side (before/after) of a binary/media file preview in the diff panel. */
export interface MediaSide {
  /** data: URL for inline rendering; empty string when the blob exceeds the cap */
  dataUrl: string
  /** blob size in bytes */
  size: number
  /** true when the file was too large to inline (dataUrl is empty) */
  tooLarge: boolean
}

/** Before/after media previews for a changed binary file. */
export interface MediaDiff {
  /** content at the base ref, or null if absent there (e.g. an added file) */
  before: MediaSide | null
  /** content in the working tree, or null if absent (e.g. a deleted file) */
  after: MediaSide | null
}

/* ---------------- File browser ---------------- */

export interface DirEntry {
  name: string
  /** path relative to the session's working directory */
  path: string
  isDir: boolean
}

/* ---------------- Search in files ---------------- */

export interface SearchOptions {
  query: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
}

export interface SearchMatch {
  /** 1-based line number */
  line: number
  /** 1-based column of the match in the actual line */
  column: number
  /** the line, leading-whitespace-trimmed and capped for display */
  text: string
  /** 0-based offset of the match within `text` (for highlighting) */
  matchStart: number
  matchLength: number
}

export interface SearchFileResult {
  /** path relative to the workspace root */
  file: string
  matches: SearchMatch[]
}

export interface SearchResults {
  files: SearchFileResult[]
  /** total match count across all files */
  resultCount: number
  fileCount: number
  /** true when the result cap was reached (more matches exist) */
  limitHit: boolean
}

/** What a replace applies to: all results, one file, or one specific match. */
export type ReplaceScope =
  | { kind: 'all' }
  | { kind: 'file'; file: string }
  | { kind: 'match'; file: string; line: number; column: number }

export interface ReplaceRequest {
  options: SearchOptions
  replacement: string
  scope: ReplaceScope
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export interface NewSessionRequest {
  projectId: string
  backend: BackendId
  environment: EnvironmentKind
  title?: string
  model?: string
  permissionMode: PermissionMode
  /**
   * The agent's first turn. Optional: omit it to create the session (worktree,
   * adapter and all) and leave it sitting idle, ready for the first prompt —
   * the Cursor-style "start an agent without a prompt yet" flow.
   */
  firstPrompt?: string
  /** environment 'ssh': which configured host to run on + remote working dir */
  remoteHostId?: string
  remoteDir?: string
}

/* ---------------- Agent events (internal protocol) ---------------- */

export interface McpServerInfo {
  name: string
  status: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

/**
 * One structured question the agent poses to the user (Claude's AskUserQuestion
 * tool). `id` is our stable key for the answer; `options` are the choices the
 * user picks from; `allowMultiple` mirrors the tool's multiSelect flag.
 */
export interface AgentQuestion {
  id: string
  prompt: string
  options: { id: string; label: string }[]
  allowMultiple?: boolean
}

/** The user's answer to one question: the option id(s) they selected. */
export interface QuestionAnswer {
  questionId: string
  optionIds: string[]
}

export type AgentEvent =
  | {
      kind: 'init'
      backendSessionId: string
      model: string
      tools: string[]
      mcpServers: McpServerInfo[]
      skills: string[]
      slashCommands: string[]
      plugins: { name: string }[]
      permissionMode: string
      version: string
    }
  /** Echo of the user's prompt, so transcripts are self-contained */
  | { kind: 'user-text'; text: string; images?: PromptImage[] }
  /** harness-injected note (background task/agent completion) — feeds the
   *  Subagents threads, never rendered as a user message */
  | { kind: 'subagent-note'; text: string }
  /** worktree setup-script lifecycle (started / finished / failed) — durable in
   *  the transcript so a failed `npm install` can't vanish with lastError */
  | { kind: 'setup-note'; text: string; isError?: boolean }
  /** a turn taken in an EXTERNAL interactive CLI on this conversation, re-synced from its jsonl */
  | { kind: 'external-turn'; role: 'user' | 'assistant'; text: string; at: number }
  | {
      kind: 'block-start'
      messageId: string
      blockIndex: number
      blockType: ContentBlock['type']
      toolName?: string
      parentToolUseId: string | null
    }
  | {
      kind: 'block-delta'
      messageId: string
      blockIndex: number
      text: string
      parentToolUseId: string | null
    }
  /** Authoritative final content for a block (replaces accumulated deltas) */
  | {
      kind: 'block-final'
      messageId: string
      blockIndex: number
      block: ContentBlock
      parentToolUseId: string | null
    }
  | {
      kind: 'tool-result'
      toolUseId: string
      content: unknown
      isError: boolean
      parentToolUseId: string | null
    }
  | {
      kind: 'hook'
      phase: 'started' | 'response'
      hookName: string
      hookEvent: string
      outcome?: string
    }
  | {
      kind: 'rate-limit'
      rateLimitType: string
      status: string
      resetsAt: number
      isUsingOverage: boolean
    }
  /** the agent's current plan/todo list (Codex turn/plan/updated; Claude TodoWrite) */
  | {
      kind: 'plan'
      entries: { step: string; status: 'pending' | 'inProgress' | 'completed' }[]
    }
  /** the agent asks the user to approve an action (command, file change) */
  | {
      kind: 'permission-request'
      requestId: string
      tool: string
      summary: string
      detail?: string
      options: string[]
      /** id of the tool_use awaiting approval — maps the request to a subagent run */
      toolUseId?: string
    }
  | {
      kind: 'permission-resolved'
      requestId: string
      decision: string
    }
  /**
   * The agent asks the user a structured multiple-choice question that we CAN
   * answer back so the turn continues (Claude AskUserQuestion — arrives as a
   * can_use_tool control request with requires_user_interaction). Distinct from
   * permission-request: the user picks an option, not allow/deny. Codex asks in
   * plain prose (no structured request) and Cursor's headless mode auto-rejects
   * the question tool, so neither emits this — only Claude does.
   */
  | {
      kind: 'question-request'
      requestId: string
      title?: string
      questions: AgentQuestion[]
    }
  | {
      kind: 'question-resolved'
      requestId: string
      answers: QuestionAnswer[]
    }
  | {
      kind: 'turn-complete'
      isError: boolean
      result?: string
      errorMessage?: string
      costUsd?: number
      inputTokens?: number
      outputTokens?: number
      /** full context-window occupancy this turn (input + cache read + creation) */
      contextTokens?: number
      /** backend-reported maximum context window for the active model */
      contextWindowTokens?: number
      numTurns?: number
      durationMs?: number
      permissionDenials?: unknown[]
    }
  | {
      /** live context-window occupancy mid-turn (from message_start / token
       *  updates) so the per-session gauge fills in while the agent is working */
      kind: 'usage'
      contextTokens?: number
      contextWindowTokens?: number
      inputTokens?: number
      outputTokens?: number
    }
  | { kind: 'stderr'; text: string }
  | { kind: 'exit'; code: number | null }

/** An event as persisted/replayed, with envelope */
export interface SessionEvent {
  sessionId: string
  /** monotonically increasing per-store sequence (SQLite rowid) — the renderer
   *  dedupes on this so replay + live streams can never double-apply */
  seq: number
  ts: number
  event: AgentEvent
}

/* ---------------- Agent-drivable browser ---------------- */

/**
 * One live browser tab the renderer reports to the main-process control plane
 * (browserControlService) so the `hang4r browser` CLI can resolve + drive it.
 * `webContentsId` is the guest `<webview>`'s id (main resolves it with
 * `webContents.fromId`); a tab with no loaded page has no webview and isn't
 * reported.
 */
export interface BrowserGuestTab {
  tabId: string
  webContentsId: number
  url: string
  title: string
  active: boolean
}

/** The full browser-tab state for a session; the renderer re-sends it on any change. */
export interface BrowserGuestReport {
  sessionId: string
  tabs: BrowserGuestTab[]
}

/** Main asks the renderer to open/navigate a session's Browser tab (goto with no live tab). */
export interface BrowserEnsureTab {
  sessionId: string
  url: string
}

/** Browser keybindings that need the pane's UI (pressed while the guest page has
 *  focus, so main intercepts and forwards; nav/reload/zoom act on the guest directly). */
export type BrowserHotkeyAction =
  | 'focus-address'
  | 'new-tab'
  | 'close-tab'
  | 'prev-tab'
  | 'next-tab'
  | 'toggle-devtools'
  | 'find'

export interface BrowserHotkey {
  sessionId: string
  tabId: string
  action: BrowserHotkeyAction
}

/* ---------------- IPC surface ---------------- */

export interface Hang4rApi {
  pickProjectFolder(): Promise<string | null>
  createProject(path: string): Promise<Project>
  listProjects(): Promise<Project[]>
  removeProject(projectId: string): Promise<void>
  listSessions(): Promise<SessionMeta[]>
  createSession(req: NewSessionRequest): Promise<SessionMeta>
  prompt(sessionId: string, text: string, images?: PromptImage[]): Promise<void>
  pickAttachments(): Promise<Attachment[]>
  interrupt(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  listArchivedSessions(): Promise<SessionMeta[]>
  cursorAvailable(): Promise<boolean>
  listCursorSessions(roots?: string[]): Promise<
    {
      id: string
      name: string
      createdAt: number
      updatedAt: number
      messageCount: number
      cwd?: string
      lastMessage?: string
    }[]
  >
  cursorTranscript(composerId: string): Promise<{ role: 'user' | 'assistant'; text: string }[]>
  claudeImportAvailable(): Promise<boolean>
  listClaudeSessions(
    roots?: string[],
    offset?: number,
    limit?: number
  ): Promise<{
    sessions: {
      id: string
      name: string
      customName?: string
      createdAt: number
      updatedAt: number
      messageCount: number
      cwd?: string
      lastMessage?: string
    }[]
    hasMore: boolean
  }>
  claudeImportTranscript(id: string): Promise<{ role: 'user' | 'assistant'; text: string }[]>
  resumeClaudeSession(id: string, cwd: string | undefined, name: string): Promise<SessionMeta>
  codexImportAvailable(): Promise<boolean>
  listCodexSessions(
    roots?: string[],
    offset?: number,
    limit?: number
  ): Promise<{
    sessions: {
      id: string
      name: string
      createdAt: number
      updatedAt: number
      messageCount: number
      cwd?: string
      lastMessage?: string
    }[]
    hasMore: boolean
  }>
  codexImportTranscript(id: string): Promise<{ role: 'user' | 'assistant'; text: string }[]>
  resumeCodexSession(id: string, cwd: string | undefined, name: string): Promise<SessionMeta>
  cursorAgentImportAvailable(): Promise<boolean>
  listCursorAgentSessions(
    roots?: string[],
    offset?: number,
    limit?: number
  ): Promise<{
    sessions: {
      id: string
      name: string
      createdAt: number
      updatedAt: number
      messageCount: number
      cwd?: string
      lastMessage?: string
    }[]
    hasMore: boolean
  }>
  cursorAgentImportTranscript(id: string): Promise<{ role: 'user' | 'assistant'; text: string }[]>
  resumeCursorAgentSession(id: string, cwd: string | undefined, name: string): Promise<SessionMeta>
  checkForUpdates(): Promise<UpdateStatus>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  getUpdateStatus(): Promise<UpdateStatus>
  toggleAppDevTools(): Promise<void>
  authStatus(): Promise<{
    claude: 'in' | 'out' | 'unknown'
    codex: 'in' | 'out' | 'unknown'
    cursor: 'in' | 'out' | 'unknown'
  }>
  authLogin(backend: 'claude' | 'codex' | 'cursor'): Promise<void>
  listCodexModels(): Promise<ModelChoice[]>
  listCursorModels(): Promise<ModelChoice[]>
  claudeUsage(force?: boolean): Promise<ClaudeUsageSnapshot>
  codexUsage(force?: boolean): Promise<CodexUsageSnapshot>
  cursorUsage(force?: boolean): Promise<CursorUsageSnapshot>
  /** SSH remote preflight: host reachable + remote claude CLI version (docs/ssh-design.md) */
  testRemoteHost(host: string): Promise<{ reachable: boolean; claudeVersion: string | null; error?: string }>
  /** ssh sessions: forward localhost:<remotePort> on the host to a fresh local port */
  openRemoteTunnel(sessionId: string, remotePort: number): Promise<{ localPort: number }>
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
  unarchiveSession(sessionId: string): Promise<SessionMeta | undefined>
  renameSession(sessionId: string, title: string): Promise<void>
  respondPermission(sessionId: string, requestId: string, decision: string): Promise<void>
  /** Answer a pending question-request (Claude AskUserQuestion) so the turn continues */
  respondQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
  duplicateSession(sessionId: string): Promise<SessionMeta>
  retrySession(sessionId: string): Promise<void>
  /** Edit an already-sent user message and restart the conversation there (CC rewind) */
  rewindSession(
    sessionId: string,
    originalText: string,
    occurrenceFromEnd: number,
    newText: string
  ): Promise<void>
  setSessionModel(sessionId: string, model: string): Promise<void>
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
  setSessionEffort(sessionId: string, effort: string): Promise<void>
  getSessionEffort(sessionId: string): Promise<string | null>
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
  /**
   * Per-backend agent default (agents.<backend>.<field> in settings.json),
   * workspace file overriding the app file. Backs the New Agent dialog's
   * pre-fill for model + permission mode.
   */
  resolveAgentDefault(
    backend: BackendId,
    field: 'model' | 'permissionMode',
    projectId?: string
  ): Promise<string | null>
  /** absolute path of a settings.json file ('app', or 'workspace' + projectId) */
  settingsFilePath(scope: SettingsScope, projectId?: string): Promise<string | null>
  /** raw text of a settings.json file (pretty `{}` when it doesn't exist yet) */
  readSettingsFile(scope: SettingsScope, projectId?: string): Promise<string>
  /** overwrite a settings.json file; rejects if the text isn't valid JSON */
  writeSettingsFile(scope: SettingsScope, text: string, projectId?: string): Promise<void>
  getSessionEvents(sessionId: string): Promise<SessionEvent[]>
  getChangedFiles(sessionId: string): Promise<ChangedFile[]>
  /** Changed files + add/del totals for one review scope (scope dropdown). */
  scopedFiles(sessionId: string, scope: DiffScope): Promise<ScopedFiles>
  /** Per-file unified-diff patch for a review scope. */
  scopedDiff(sessionId: string, scope: DiffScope, path: string, ignoreWs?: boolean): Promise<string>
  /** Per-scope file counts + availability for the scope dropdown. */
  scopeSummary(sessionId: string): Promise<ScopeSummary[]>
  gitStatus(sessionId: string): Promise<Record<string, { badge: string; staged: boolean }>>
  gitLineStatus(
    sessionId: string,
    path: string
  ): Promise<{ added: number[]; modified: number[]; deleted: number[] }>
  gitStage(sessionId: string, path: string): Promise<void>
  gitUnstage(sessionId: string, path: string): Promise<void>
  gitDiscard(sessionId: string, path: string): Promise<void>
  getFileDiff(sessionId: string, path: string, ignoreWs?: boolean): Promise<string>
  /** Before/after media previews for a changed binary file (images, PDF). */
  getMediaDiff(sessionId: string, path: string): Promise<MediaDiff>
  revertHunk(sessionId: string, path: string, patch: string): Promise<void>
  stageHunk(sessionId: string, path: string, patch: string): Promise<void>
  hunkAt(sessionId: string, path: string, line: number): Promise<string | null>
  stageHunkAt(sessionId: string, path: string, line: number): Promise<void>
  revertHunkAt(sessionId: string, path: string, line: number): Promise<void>
  submitReview(sessionId: string, comments: ReviewComment[]): Promise<void>
  commitSession(sessionId: string, message: string): Promise<string | null>
  commitPushSession(sessionId: string, message: string): Promise<string | null>
  branchCommitPushSession(
    sessionId: string,
    branch: string,
    message: string
  ): Promise<string | null>
  mergeSessionToBase(sessionId: string): Promise<void>
  createSessionPr(sessionId: string): Promise<string>
  /** the session's REAL current branch (null: not a repo / detached / cwd gone) */
  currentBranch(sessionId: string): Promise<string | null>
  appVersion(): Promise<string>
  // file browser
  listDir(sessionId: string, relPath: string): Promise<DirEntry[]>
  readFile(sessionId: string, relPath: string): Promise<{ content: string; truncated: boolean }>
  writeFile(sessionId: string, relPath: string, content: string): Promise<void>
  listAllFiles(sessionId: string): Promise<string[]>
  readSources(sessionId: string): Promise<{ path: string; content: string }[]>
  searchFiles(
    sessionId: string,
    query: string
  ): Promise<{ path: string; line: number; text: string }[]>
  /** Cursor-style search-in-files: grouped matches with find options */
  searchInFiles(sessionId: string, options: SearchOptions): Promise<SearchResults>
  /** Rewrite files on disk to apply a replacement over a search scope */
  replaceInFiles(
    sessionId: string,
    req: ReplaceRequest
  ): Promise<{ filesChanged: number; replacements: number }>
  createFile(sessionId: string, relPath: string): Promise<void>
  createDir(sessionId: string, relPath: string): Promise<void>
  renamePath(sessionId: string, from: string, to: string): Promise<void>
  removePath(sessionId: string, relPath: string): Promise<void>
  resolveImport(sessionId: string, from: string, spec: string): Promise<string | null>
  findDefinition(
    sessionId: string,
    symbol: string
  ): Promise<{ path: string; line: number } | null>
  tailFile(absPath: string): Promise<string>
  readFileDataUrl(sessionId: string, relPath: string): Promise<string | null>
  /** HTML preview: publish the live editor buffer for the hang4r-preview:// entry doc */
  setPreviewDoc(sessionId: string, relPath: string, html: string): Promise<void>
  /** import turns taken in an external interactive CLI (returns count imported) */
  resyncSession(sessionId: string): Promise<number>
  /** whether the session has a live agent process (bg tasks die with it) */
  agentAlive(sessionId: string): Promise<boolean>
  /** the CLI's own allow/deny permission rules that apply to this session's cwd */
  getPermissionRules(
    sessionId: string
  ): Promise<{ rule: string; kind: 'allow' | 'deny'; source: string }[]>
  /** Cursor-style quit confirm: main asks, the renderer dialog answers */
  onQuitConfirm(cb: (info: { message: string; detail: string }) => void): () => void
  answerQuitConfirm(quit: boolean): Promise<void>
  // terminal (id = a per-terminal id; sessionId resolves the working directory)
  startTerminal(id: string, sessionId: string, cols: number, rows: number): Promise<void>
  startProcess(
    id: string,
    sessionId: string,
    command: string,
    cols: number,
    rows: number
  ): Promise<void>
  processRunning(id: string): Promise<boolean>
  writeTerminal(id: string, data: string): Promise<void>
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>
  disposeTerminal(id: string): Promise<void>
  /** ⌘K clear: also drop the main-process scrollback so a tab-switch re-attach
   *  doesn't replay the old output back into the cleared terminal */
  clearTerminal(id: string): Promise<void>
  onTerminalData(cb: (id: string, data: string) => void): () => void
  onTerminalExit(cb: (id: string, code: number) => void): () => void
  // events
  onAgentEvent(cb: (ev: SessionEvent) => void): () => void
  onSessionUpdated(cb: (session: SessionMeta) => void): () => void
  /** a completion notification was clicked — surface this session */
  onFocusSession(cb: (sessionId: string) => void): () => void
  /** a settings.json file changed on disk (external edit) — reload from it */
  onSettingsChanged(cb: (scope: SettingsScope) => void): () => void
  // agent-drivable browser (the `hang4r browser` CLI drives these guest tabs)
  /** the renderer reports a session's live browser tabs to the control plane */
  reportBrowserGuests(report: BrowserGuestReport): Promise<void>
  /** dock the active tab's page devtools into a native view at these window-space bounds */
  dockDevtools(
    guestWcId: number,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<boolean>
  setDevtoolsBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  closeDevtools(): Promise<void>
  /** main asks the renderer to open/navigate a session's Browser tab (goto ensure-tab) */
  onBrowserEnsureTab(cb: (info: BrowserEnsureTab) => void): () => void
  onBrowserHotkey(cb: (info: BrowserHotkey) => void): () => void
  /** a link the browser guest tried to open in a new window → open as a new tab */
  onBrowserOpenUrl(cb: (info: BrowserEnsureTab) => void): () => void
}

/** which settings.json file: app-global (~/.hang4r) or a workspace's (.hang4r) */
export type SettingsScope = 'app' | 'workspace'
