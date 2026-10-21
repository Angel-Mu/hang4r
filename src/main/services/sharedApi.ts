import { app } from 'electron'
import type {
  BackendId,
  ModelChoice,
  Project,
  QuestionAnswer,
  SessionMeta
} from '../../shared/protocol'
import type { BridgeEventPage, BridgeEventPageOpts } from '../../shared/bridge'
import type { SessionManager } from './sessionManager'
import type { Store } from './store'
import type { SettingsService } from './settingsService'
import { eventPage } from './bridgeHistory'
import { CodexModelService } from './codexModelService'
import { CursorModelService } from './cursorModelService'

/**
 * The handlers the mobile bridge and the control socket both expose. Each
 * surface keeps its OWN allowlist (BRIDGE_METHODS / CTL_METHODS) and picks from
 * here, so adding a handler never widens either surface by itself.
 */
export interface SharedApi {
  listProjects: () => Project[]
  listSessions: () => SessionMeta[]
  listArchivedSessions: () => SessionMeta[]
  getSessionEventsPage: (sessionId: string, opts?: BridgeEventPageOpts) => BridgeEventPage
  interrupt: (sessionId: string) => void
  respondPermission: (sessionId: string, requestId: string, decision: string) => void
  respondQuestion: (sessionId: string, requestId: string, answers: QuestionAnswer[]) => void
  archiveSession: (sessionId: string) => Promise<void>
  listCodexModels: () => Promise<ModelChoice[]>
  listCursorModels: () => Promise<ModelChoice[]>
  resolveAgentDefault: (
    backend: BackendId,
    field: 'model' | 'permissionMode',
    projectId?: string
  ) => string | null
  appVersion: () => string
  agentAlive: (sessionId: string) => boolean
  currentBranch: (sessionId: string) => Promise<string | null>
}

export function buildSharedApi(deps: {
  store: Store
  sessions: SessionManager
  settings: SettingsService
}): SharedApi {
  const { store, sessions, settings } = deps
  return {
    listProjects: () => store.listProjects(),
    listSessions: () => store.listSessions(),
    listArchivedSessions: () => store.listArchivedSessions(),
    getSessionEventsPage: (sessionId: string, opts?: BridgeEventPageOpts) =>
      eventPage(
        {
          backward: (before) => store.iterateEventsBackward(sessionId, before),
          latest: (kind, before) => store.latestEventOfKind(sessionId, kind, before)
        },
        {
          before: typeof opts?.before === 'number' ? opts.before : undefined,
          budget:
            (typeof opts?.budget === 'number' ? opts.budget : undefined) ??
            (Number(process.env.HANG4R_TEST_BRIDGE_PAGE_BYTES) || undefined)
        }
      ),
    interrupt: (sessionId: string) => sessions.interrupt(sessionId),
    respondPermission: (sessionId: string, requestId: string, decision: string) =>
      sessions.respondPermission(sessionId, requestId, decision),
    respondQuestion: (sessionId: string, requestId: string, answers: QuestionAnswer[]) =>
      sessions.respondQuestion(sessionId, requestId, answers),
    archiveSession: (sessionId: string) => sessions.archive(sessionId),
    listCodexModels: () => CodexModelService.list(settings.getSetting('codexBinaryPath')),
    listCursorModels: () => CursorModelService.list(settings.getSetting('cursorBinaryPath')),
    resolveAgentDefault: (backend: BackendId, field: 'model' | 'permissionMode', projectId?: string) =>
      settings.resolveAgentDefault(backend, field, projectId),
    appVersion: () => app.getVersion(),
    agentAlive: (sessionId: string) => sessions.agentAlive(sessionId),
    currentBranch: (sessionId: string) => sessions.currentBranch(sessionId)
  }
}
