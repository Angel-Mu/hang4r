import { contextBridge, ipcRenderer } from 'electron'
import type {
  BackendId,
  BrowserEnsureTab,
  BrowserHotkey,
  BrowserGuestReport,
  DiffScope,
  Hang4rApi,
  NewSessionRequest,
  PermissionMode,
  PromptImage,
  QuestionAnswer,
  ReplaceRequest,
  ReviewComment,
  SearchOptions,
  SessionEvent,
  SessionMeta,
  SettingsScope,
  UpdateStatus
} from '../shared/protocol'

const api: Hang4rApi = {
  pickProjectFolder: () => ipcRenderer.invoke('projects:pick-folder'),
  createProject: (path: string) => ipcRenderer.invoke('projects:create', path),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  removeProject: (projectId: string) => ipcRenderer.invoke('projects:remove', projectId),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (req: NewSessionRequest) => ipcRenderer.invoke('sessions:create', req),
  prompt: (sessionId: string, text: string, images?: PromptImage[]) =>
    ipcRenderer.invoke('sessions:prompt', sessionId, text, images),
  pickAttachments: () => ipcRenderer.invoke('dialog:pick-attachments'),
  interrupt: (sessionId: string) => ipcRenderer.invoke('sessions:interrupt', sessionId),
  archiveSession: (sessionId: string) => ipcRenderer.invoke('sessions:archive', sessionId),
  dropWorktree: (sessionId: string) => ipcRenderer.invoke('sessions:drop-worktree', sessionId),
  recreateWorktree: (sessionId: string) =>
    ipcRenderer.invoke('sessions:recreate-worktree', sessionId),
  listArchivedSessions: () => ipcRenderer.invoke('sessions:list-archived'),
  cursorAvailable: () => ipcRenderer.invoke('cursor:available'),
  listCursorSessions: (roots?: string[]) => ipcRenderer.invoke('cursor:list', roots),
  cursorTranscript: (composerId: string) => ipcRenderer.invoke('cursor:transcript', composerId),
  claudeImportAvailable: () => ipcRenderer.invoke('claude:available'),
  listClaudeSessions: (roots?: string[], offset?: number, limit?: number) =>
    ipcRenderer.invoke('claude:list', roots, offset, limit),
  claudeImportTranscript: (id: string) => ipcRenderer.invoke('claude:transcript', id),
  resumeClaudeSession: (id: string, cwd: string | undefined, name: string) =>
    ipcRenderer.invoke('claude:resume', id, cwd, name),
  codexImportAvailable: () => ipcRenderer.invoke('codex:available'),
  listCodexSessions: (roots?: string[], offset?: number, limit?: number) =>
    ipcRenderer.invoke('codex:list', roots, offset, limit),
  codexImportTranscript: (id: string) => ipcRenderer.invoke('codex:transcript', id),
  resumeCodexSession: (id: string, cwd: string | undefined, name: string) =>
    ipcRenderer.invoke('codex:resume', id, cwd, name),
  cursorAgentImportAvailable: () => ipcRenderer.invoke('cursorAgent:available'),
  listCursorAgentSessions: (roots?: string[], offset?: number, limit?: number) =>
    ipcRenderer.invoke('cursorAgent:list', roots, offset, limit),
  cursorAgentImportTranscript: (id: string) => ipcRenderer.invoke('cursorAgent:transcript', id),
  resumeCursorAgentSession: (id: string, cwd: string | undefined, name: string) =>
    ipcRenderer.invoke('cursorAgent:resume', id, cwd, name),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  toggleAppDevTools: () => ipcRenderer.invoke('app:toggle-devtools'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: (backend: 'claude' | 'codex' | 'cursor') => ipcRenderer.invoke('auth:login', backend),
  listCodexModels: () => ipcRenderer.invoke('models:codex'),
  listCursorModels: () => ipcRenderer.invoke('models:cursor'),
  claudeUsage: (force?: boolean) => ipcRenderer.invoke('usage:claude', force),
  codexUsage: (force?: boolean) => ipcRenderer.invoke('usage:codex', force),
  cursorUsage: (force?: boolean) => ipcRenderer.invoke('usage:cursor', force),
  testRemoteHost: (host: string) => ipcRenderer.invoke('remote:test', host),
  openRemoteTunnel: (sessionId: string, remotePort: number) =>
    ipcRenderer.invoke('remote:tunnel', sessionId, remotePort),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const handler = (_e: unknown, status: UpdateStatus): void => cb(status)
    ipcRenderer.on('update-status', handler)
    return () => ipcRenderer.removeListener('update-status', handler)
  },
  unarchiveSession: (sessionId: string) => ipcRenderer.invoke('sessions:unarchive', sessionId),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke('sessions:rename', sessionId, title),
  respondPermission: (sessionId: string, requestId: string, decision: string) =>
    ipcRenderer.invoke('sessions:respond-permission', sessionId, requestId, decision),
  respondQuestion: (sessionId: string, requestId: string, answers: QuestionAnswer[]) =>
    ipcRenderer.invoke('sessions:respond-question', sessionId, requestId, answers),
  duplicateSession: (sessionId: string) => ipcRenderer.invoke('sessions:duplicate', sessionId),
  retrySession: (sessionId: string) => ipcRenderer.invoke('sessions:retry', sessionId),
  rewindSession: (sessionId: string, originalText: string, occurrenceFromEnd: number, newText: string) =>
    ipcRenderer.invoke('sessions:rewind', sessionId, originalText, occurrenceFromEnd, newText),
  setSessionModel: (sessionId: string, model: string) =>
    ipcRenderer.invoke('sessions:set-model', sessionId, model),
  setSessionPermissionMode: (sessionId: string, mode: PermissionMode) =>
    ipcRenderer.invoke('sessions:set-permission-mode', sessionId, mode),
  setSessionEffort: (sessionId: string, effort: string) =>
    ipcRenderer.invoke('sessions:set-effort', sessionId, effort),
  getSessionEffort: (sessionId: string) => ipcRenderer.invoke('sessions:get-effort', sessionId),
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  resolveAgentDefault: (backend: BackendId, field: 'model' | 'permissionMode', projectId?: string) =>
    ipcRenderer.invoke('settings:resolve-agent-default', backend, field, projectId),
  settingsFilePath: (scope: SettingsScope, projectId?: string) =>
    ipcRenderer.invoke('settings-file:path', scope, projectId),
  readSettingsFile: (scope: SettingsScope, projectId?: string) =>
    ipcRenderer.invoke('settings-file:read', scope, projectId),
  writeSettingsFile: (scope: SettingsScope, text: string, projectId?: string) =>
    ipcRenderer.invoke('settings-file:write', scope, text, projectId),
  getSessionEvents: (sessionId: string) => ipcRenderer.invoke('sessions:events', sessionId),
  getChangedFiles: (sessionId: string) => ipcRenderer.invoke('sessions:changed-files', sessionId),
  scopedFiles: (sessionId: string, scope: DiffScope) =>
    ipcRenderer.invoke('git:scoped-files', sessionId, scope),
  scopedDiff: (sessionId: string, scope: DiffScope, path: string, ignoreWs?: boolean) =>
    ipcRenderer.invoke('git:scoped-diff', sessionId, scope, path, ignoreWs),
  scopeSummary: (sessionId: string) => ipcRenderer.invoke('git:scope-summary', sessionId),
  gitStatus: (sessionId: string) => ipcRenderer.invoke('git:status', sessionId),
  gitLineStatus: (sessionId: string, path: string) =>
    ipcRenderer.invoke('git:line-status', sessionId, path),
  gitStage: (sessionId: string, path: string) => ipcRenderer.invoke('git:stage', sessionId, path),
  gitUnstage: (sessionId: string, path: string) =>
    ipcRenderer.invoke('git:unstage', sessionId, path),
  gitDiscard: (sessionId: string, path: string) =>
    ipcRenderer.invoke('git:discard', sessionId, path),
  getFileDiff: (sessionId: string, path: string, ignoreWs?: boolean) =>
    ipcRenderer.invoke('sessions:file-diff', sessionId, path, ignoreWs),
  getMediaDiff: (sessionId: string, path: string) =>
    ipcRenderer.invoke('sessions:media-diff', sessionId, path),
  revertHunk: (sessionId: string, path: string, patch: string) =>
    ipcRenderer.invoke('git:revert-hunk', sessionId, path, patch),
  stageHunk: (sessionId: string, path: string, patch: string) =>
    ipcRenderer.invoke('git:stage-hunk', sessionId, path, patch),
  hunkAt: (sessionId: string, path: string, line: number) =>
    ipcRenderer.invoke('git:hunk-at', sessionId, path, line) as Promise<string | null>,
  stageHunkAt: (sessionId: string, path: string, line: number) =>
    ipcRenderer.invoke('git:stage-hunk-at', sessionId, path, line),
  revertHunkAt: (sessionId: string, path: string, line: number) =>
    ipcRenderer.invoke('git:revert-hunk-at', sessionId, path, line),
  submitReview: (sessionId: string, comments: ReviewComment[]) =>
    ipcRenderer.invoke('sessions:submit-review', sessionId, comments),
  commitSession: (sessionId: string, message: string) =>
    ipcRenderer.invoke('sessions:commit', sessionId, message),
  commitPushSession: (sessionId: string, message: string) =>
    ipcRenderer.invoke('sessions:commit-push', sessionId, message),
  branchCommitPushSession: (sessionId: string, branch: string, message: string) =>
    ipcRenderer.invoke('sessions:branch-commit-push', sessionId, branch, message),
  currentBranch: (sessionId: string) => ipcRenderer.invoke('sessions:current-branch', sessionId),
  appVersion: () => ipcRenderer.invoke('app:version'),
  mergeSessionToBase: (sessionId: string) => ipcRenderer.invoke('sessions:merge-base', sessionId),
  createSessionPr: (sessionId: string) => ipcRenderer.invoke('sessions:create-pr', sessionId),
  listDir: (sessionId: string, relPath: string) =>
    ipcRenderer.invoke('files:list', sessionId, relPath),
  readFile: (sessionId: string, relPath: string) =>
    ipcRenderer.invoke('files:read', sessionId, relPath),
  writeFile: (sessionId: string, relPath: string, content: string) =>
    ipcRenderer.invoke('files:write', sessionId, relPath, content),
  listAllFiles: (sessionId: string) => ipcRenderer.invoke('files:all', sessionId),
  readSources: (sessionId: string) =>
    ipcRenderer.invoke('files:sources', sessionId) as Promise<{ path: string; content: string }[]>,
  searchFiles: (sessionId: string, query: string) =>
    ipcRenderer.invoke('files:search', sessionId, query),
  searchInFiles: (sessionId: string, options: SearchOptions) =>
    ipcRenderer.invoke('search:query', sessionId, options),
  replaceInFiles: (sessionId: string, req: ReplaceRequest) =>
    ipcRenderer.invoke('search:replace', sessionId, req),
  createFile: (sessionId: string, relPath: string) =>
    ipcRenderer.invoke('files:create', sessionId, relPath),
  createDir: (sessionId: string, relPath: string) =>
    ipcRenderer.invoke('files:mkdir', sessionId, relPath),
  renamePath: (sessionId: string, from: string, to: string) =>
    ipcRenderer.invoke('files:rename', sessionId, from, to),
  removePath: (sessionId: string, relPath: string) =>
    ipcRenderer.invoke('files:remove', sessionId, relPath),
  resolveImport: (sessionId: string, from: string, spec: string) =>
    ipcRenderer.invoke('files:resolve', sessionId, from, spec),
  findDefinition: (sessionId: string, symbol: string) =>
    ipcRenderer.invoke('files:definition', sessionId, symbol),
  tailFile: (absPath: string) => ipcRenderer.invoke('files:tail', absPath),
  readFileDataUrl: (sessionId: string, relPath: string) =>
    ipcRenderer.invoke('files:data-url', sessionId, relPath),
  setPreviewDoc: (sessionId: string, relPath: string, html: string) =>
    ipcRenderer.invoke('preview:set', sessionId, relPath, html),
  resyncSession: (sessionId: string) => ipcRenderer.invoke('sessions:resync', sessionId),
  agentAlive: (sessionId: string) => ipcRenderer.invoke('sessions:agent-alive', sessionId),
  getPermissionRules: (sessionId: string) => ipcRenderer.invoke('sessions:permission-rules', sessionId),
  onQuitConfirm: (cb: (info: { message: string; detail: string }) => void) => {
    const handler = (_e: unknown, info: { message: string; detail: string }): void => cb(info)
    ipcRenderer.on('quit:confirm', handler)
    return () => ipcRenderer.removeListener('quit:confirm', handler)
  },
  answerQuitConfirm: (quit: boolean) => ipcRenderer.invoke('quit:answer', quit),
  startTerminal: (id: string, sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:start', id, sessionId, cols, rows),
  startProcess: (id: string, sessionId: string, command: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:start-command', id, sessionId, command, cols, rows),
  processRunning: (id: string) => ipcRenderer.invoke('pty:running', id) as Promise<boolean>,
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  disposeTerminal: (id: string) => ipcRenderer.invoke('pty:dispose', id),
  clearTerminal: (id: string) => ipcRenderer.invoke('pty:clear', id),
  onTerminalData: (cb: (id: string, data: string) => void) => {
    const handler = (_e: unknown, id: string, data: string): void => cb(id, data)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  onTerminalExit: (cb: (id: string, code: number) => void) => {
    const handler = (_e: unknown, id: string, code: number): void => cb(id, code)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  },
  onAgentEvent: (cb: (ev: SessionEvent) => void) => {
    const handler = (_e: unknown, ev: SessionEvent): void => cb(ev)
    ipcRenderer.on('agent-event', handler)
    return () => ipcRenderer.removeListener('agent-event', handler)
  },
  onSessionUpdated: (cb: (session: SessionMeta) => void) => {
    const handler = (_e: unknown, session: SessionMeta): void => cb(session)
    ipcRenderer.on('session-updated', handler)
    return () => ipcRenderer.removeListener('session-updated', handler)
  },
  onFocusSession: (cb: (sessionId: string) => void) => {
    const handler = (_e: unknown, sessionId: string): void => cb(sessionId)
    ipcRenderer.on('focus-session', handler)
    return () => ipcRenderer.removeListener('focus-session', handler)
  },
  onSettingsChanged: (cb: (scope: SettingsScope) => void) => {
    const handler = (_e: unknown, scope: SettingsScope): void => cb(scope)
    ipcRenderer.on('settings-changed', handler)
    return () => ipcRenderer.removeListener('settings-changed', handler)
  },
  reportBrowserGuests: (report: BrowserGuestReport) =>
    ipcRenderer.invoke('browser:guest-register', report),
  dockDevtools: (guestWcId: number, bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:devtools-dock', { guestWcId, bounds }),
  setDevtoolsBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:devtools-bounds', { bounds }),
  closeDevtools: () => ipcRenderer.invoke('browser:devtools-close'),
  onBrowserEnsureTab: (cb: (info: BrowserEnsureTab) => void) => {
    const handler = (_e: unknown, info: BrowserEnsureTab): void => cb(info)
    ipcRenderer.on('browser:ensure-tab', handler)
    return () => ipcRenderer.removeListener('browser:ensure-tab', handler)
  },
  onBrowserHotkey: (cb: (info: BrowserHotkey) => void) => {
    const handler = (_e: unknown, info: BrowserHotkey): void => cb(info)
    ipcRenderer.on('browser:hotkey', handler)
    return () => ipcRenderer.removeListener('browser:hotkey', handler)
  },
  onBrowserOpenUrl: (cb: (info: BrowserEnsureTab) => void) => {
    const handler = (_e: unknown, info: BrowserEnsureTab): void => cb(info)
    ipcRenderer.on('browser:open-url', handler)
    return () => ipcRenderer.removeListener('browser:open-url', handler)
  }
}

contextBridge.exposeInMainWorld('hang4r', api)
