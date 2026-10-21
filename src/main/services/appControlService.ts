import { isAbsolute, resolve as resolvePath, sep } from 'node:path'
import type {
  BackendId,
  EnvironmentKind,
  ModelChoice,
  PermissionMode,
  QuestionAnswer,
  SessionEvent,
  SessionMeta
} from '../../shared/protocol'
import { CLAUDE_MODELS } from '../../shared/claudeModels'
import { isSessionBusyError, isWorktreeMissingError } from '../../shared/sessionBusy'
import { shownUserText } from '../../shared/userText'
import type { SessionManager } from './sessionManager'
import type { Store } from './store'
import type { SettingsService } from './settingsService'
import type { SharedApi } from './sharedApi'
import { GitService } from './gitService'

/**
 * The `app.*` namespace on ctl.sock: what `hang4r sessions …` calls. Its own
 * allowlist — the mobile BRIDGE_METHODS is a different, narrower-in-other-ways
 * surface and neither implies the other. Excluded on purpose: deleting, git
 * writes, terminals, settings writes, file access, rewind, and changing a live
 * session's model or permission mode.
 */
export const CTL_METHODS = [
  'status',
  'projects',
  'models',
  'sessions',
  'new',
  'show',
  'send',
  'wait',
  'interrupt',
  'respond',
  'archive'
] as const
export type CtlMethod = (typeof CTL_METHODS)[number]

export type CtlErrorCode =
  | 'usage'
  | 'not-found'
  | 'busy'
  | 'worktree-missing'
  | 'internal'

/** An error the CLI turns into a stable exit code (see resources/ctl/hang4r-cli.js). */
export class CtlError extends Error {
  constructor(
    readonly code: CtlErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface CtlRequest {
  cmd: string
  args: Record<string, unknown>
  /** self-declared label of whoever is calling — display only, never trusted */
  caller?: string
}

/** the transcript events a `wait` can resolve on (see evaluate / livePending) */
const WAKE_KINDS = new Set<string>([
  'turn-complete',
  'exit',
  'permission-request',
  'permission-resolved',
  'question-request',
  'question-resolved'
])

const RESULT_CAP = 20_000
const SHOW_EVENTS = 20
const DEFAULT_WAIT_S = 600
const MAX_WAIT_S = 3600
const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
const BACKENDS: BackendId[] = ['claude', 'codex', 'cursor']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export interface PendingRequest {
  requestId: string
  kind: 'permission' | 'question'
  tool?: string
  summary?: string
  detail?: string
  /** permission: the decisions you may answer with */
  options?: string[]
  /** question: the questions and their option ids */
  questions?: { id: string; text: string; options: { id: string; label: string }[] }[]
}

export type WaitReason =
  | 'turn-complete'
  | 'needs-input'
  | 'error'
  | 'timeout'
  | 'archived'
  | 'idle'

interface Waiter {
  sessionId: string
  check: () => void
}

export class AppControlService {
  private waiters = new Set<Waiter>()

  constructor(
    private readonly deps: {
      store: Store
      sessions: SessionManager
      settings: SettingsService
      api: SharedApi
      userData: string
      version: string
    }
  ) {}

  /** session-event broadcast (wired next to the renderer/bridge fan-out) */
  onAgentEvent(ev: SessionEvent): void {
    // Only events that can change a wait's outcome. The broadcast carries every
    // streamed token (block-delta, seq 0 = transient), and each poke re-reads the
    // transcript: evaluating per token was a SQLite scan per delta per waiter.
    if (ev.seq === 0 || !WAKE_KINDS.has(ev.event.kind)) return
    this.poke(ev.sessionId)
  }

  onSessionUpdated(session: SessionMeta): void {
    // session-updated also fires for title/cost/model edits; evaluate() only
    // reads the status (and lastError that rides with it)
    if (this.lastStatus.get(session.id) === session.status) return
    this.lastStatus.set(session.id, session.status)
    this.poke(session.id)
  }

  private lastStatus = new Map<string, SessionMeta['status']>()

  /** quit: resolve nothing, just stop holding timers + references */
  dispose(): void {
    for (const w of [...this.waiters]) w.check = () => {}
    this.waiters.clear()
    this.lastStatus.clear()
  }

  private poke(sessionId: string): void {
    for (const w of [...this.waiters]) if (w.sessionId === sessionId) w.check()
  }

  /** Dispatch one `app.<cmd>` request. `signal` aborts when the caller's socket closes. */
  async handle(req: CtlRequest, signal: AbortSignal): Promise<unknown> {
    const name = req.cmd.replace(/^app\./, '')
    if (!(CTL_METHODS as readonly string[]).includes(name)) {
      throw new CtlError('usage', `Unknown command: ${req.cmd}`)
    }
    const caller = cleanCaller(req.caller)
    const args = req.args ?? {}
    // audit trail: who asked for what (self-declared label — display only)
    console.log(
      '[appControl]',
      JSON.stringify({
        ts: new Date().toISOString(),
        cmd: name,
        caller: caller ?? null,
        sessionId: typeof args.sessionId === 'string' ? args.sessionId : null
      })
    )
    try {
      switch (name as CtlMethod) {
        case 'status':
          return {
            version: this.deps.version,
            userData: this.deps.userData,
            pid: process.pid,
            // open `wait`s: a diagnostic, and what the socket-hygiene test watches
            waiters: this.waiters.size
          }
        case 'projects':
          return this.projects()
        case 'models':
          return await this.models(optStr(args.backend))
        case 'sessions':
          return await this.list(num(args.limit, 50))
        case 'new':
          return await this.create(args, caller, signal)
        case 'show':
          return await this.show(reqStr(args.sessionId, 'sessionId'))
        case 'send':
          return await this.send(args, caller, signal)
        case 'wait':
          return await this.wait(args, signal)
        case 'interrupt':
          return await this.interrupt(reqStr(args.sessionId, 'sessionId'))
        case 'respond':
          return await this.respond(args, signal)
        case 'archive':
          return await this.archive(reqStr(args.sessionId, 'sessionId'))
      }
    } catch (err) {
      throw toCtlError(err)
    }
  }

  /* ---------------- reads ---------------- */

  private projects(): unknown {
    const counts = new Map<string, number>()
    for (const s of this.deps.store.listSessions()) {
      counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1)
    }
    return {
      projects: this.deps.store.listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        sessionCount: counts.get(p.id) ?? 0
      }))
    }
  }

  private async models(backend?: string): Promise<unknown> {
    if (backend && !BACKENDS.includes(backend as BackendId)) {
      throw new CtlError('usage', `--backend must be one of: ${BACKENDS.join(', ')}`)
    }
    const want = (b: BackendId): boolean => !backend || backend === b
    const out: { backend: BackendId; id: string; label: string; default: boolean }[] = []
    const add = (b: BackendId, list: ModelChoice[]): void => {
      const def = this.deps.api.resolveAgentDefault(b, 'model') ?? ''
      for (const m of list) out.push({ backend: b, id: m.value, label: m.label, default: m.value === def })
    }
    if (want('claude')) add('claude', CLAUDE_MODELS)
    if (want('codex')) add('codex', await this.deps.api.listCodexModels().catch(() => []))
    if (want('cursor')) add('cursor', await this.deps.api.listCursorModels().catch(() => []))
    return { models: out }
  }

  private async list(limit: number): Promise<unknown> {
    const sessions = this.deps.store
      .listSessions()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit))
    return { sessions: await Promise.all(sessions.map((s) => this.sessionObject(s))) }
  }

  private async show(sessionId: string): Promise<unknown> {
    const s = this.requireSession(sessionId)
    return { session: await this.sessionObject(s, { branch: true }), events: this.recentEvents(sessionId) }
  }

  /* ---------------- writes ---------------- */

  private async create(
    args: Record<string, unknown>,
    caller: string | undefined,
    signal: AbortSignal
  ): Promise<unknown> {
    const { store, sessions, settings } = this.deps
    const project = this.resolveProject(optStr(args.project), optStr(args.cwd))
    const backend = (optStr(args.backend) ?? 'claude') as BackendId
    if (!BACKENDS.includes(backend)) {
      throw new CtlError('usage', `--backend must be one of: ${BACKENDS.join(', ')}`)
    }
    const effort = optStr(args.effort)
    if (effort && !EFFORTS.includes(effort)) {
      throw new CtlError('usage', `--effort must be one of: ${EFFORTS.join(', ')}`)
    }
    const explicitEnv = optStr(args.env)
    if (explicitEnv && explicitEnv !== 'local' && explicitEnv !== 'worktree') {
      throw new CtlError('usage', '--env must be local or worktree (ssh is not available here)')
    }
    // The Start-agent modal's defaults, resolved the same way: environment from
    // `defaultEnvironment` (else worktree), permission mode from the per-agent
    // default then `defaultPermissionMode` (else acceptEdits), model from the
    // per-agent default then (claude) `defaultModel`.
    let environment: EnvironmentKind = (explicitEnv as EnvironmentKind | undefined) ?? 'worktree'
    if (!explicitEnv) {
      const configured = settings.getSetting('defaultEnvironment')
      environment = configured === 'local' ? 'local' : 'worktree'
      // a non-git project cannot have a worktree; the modal would error here, a
      // headless caller gets a working local session (the object reports it)
      if (environment === 'worktree' && !(await GitService.isRepo(project.path))) {
        environment = 'local'
      }
    }
    const permissionMode = (optStr(args.permissionMode) ??
      settings.resolveAgentDefault(backend, 'permissionMode', project.id) ??
      settings.getSetting('defaultPermissionMode') ??
      'acceptEdits') as PermissionMode
    if (!PERMISSION_MODES.includes(permissionMode)) {
      throw new CtlError('usage', `--permission-mode must be one of: ${PERMISSION_MODES.join(', ')}`)
    }
    const model =
      optStr(args.model) ||
      settings.resolveAgentDefault(backend, 'model', project.id) ||
      (backend === 'claude' ? settings.getSetting('defaultModel') : null) ||
      undefined
    const prompt = optStr(args.prompt)

    const session = await sessions.createSession(
      {
        projectId: project.id,
        backend,
        environment,
        permissionMode,
        model,
        effort,
        title: optStr(args.title),
        firstPrompt: prompt
      },
      { origin: originOf(caller) }
    )
    const after = prompt ? ((await this.userTextSeq(session.id, 0)) ?? 0) : 0
    const object = await this.sessionObject(store.getSession(session.id) ?? session)
    if (!args.wait || !prompt) return { session: object, after }
    return this.waitFor(session.id, after, secondsArg(args.timeout), signal)
  }

  private async send(
    args: Record<string, unknown>,
    caller: string | undefined,
    signal: AbortSignal
  ): Promise<unknown> {
    const sessionId = reqStr(args.sessionId, 'sessionId')
    const prompt = reqStr(args.prompt, 'prompt')
    const session = this.requireSession(sessionId)
    if (session.status === 'archived') {
      throw new CtlError('not-found', 'That session is archived; unarchive it in hang4r first.')
    }
    const base = this.deps.store.latestSeq(sessionId)
    // headless: a missing worktree is an error with a code, never a dialog
    await this.deps.sessions.prompt(sessionId, prompt, undefined, undefined, undefined, false, {
      origin: originOf(caller),
      worktree: args.rebuildWorktree ? 'rebuild' : 'fail'
    })
    const after = (await this.userTextSeq(sessionId, base)) ?? base
    if (!args.wait) {
      return { session: await this.sessionObject(this.requireSession(sessionId)), after }
    }
    return this.waitFor(sessionId, after, secondsArg(args.timeout), signal)
  }

  private async wait(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const sessionId = reqStr(args.sessionId, 'sessionId')
    this.requireSession(sessionId)
    const after = typeof args.after === 'number' ? args.after : null
    return this.waitFor(sessionId, after, secondsArg(args.timeout), signal)
  }

  private async interrupt(sessionId: string): Promise<unknown> {
    this.requireSession(sessionId)
    this.deps.api.interrupt(sessionId)
    return { session: await this.sessionObject(this.requireSession(sessionId)) }
  }

  private async archive(sessionId: string): Promise<unknown> {
    this.requireSession(sessionId)
    await this.deps.api.archiveSession(sessionId)
    return { id: sessionId, status: 'archived' }
  }

  private async respond(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const sessionId = reqStr(args.sessionId, 'sessionId')
    const requestId = reqStr(args.requestId, 'requestId')
    this.requireSession(sessionId)
    // only a LIVE request can be answered: unresolved, newer than the last
    // turn-complete/exit, and its adapter still up. Anything else used to
    // "succeed" silently because the adapter call is a no-op without a process.
    const pending = this.livePending(sessionId)
    if (!pending || pending.requestId !== requestId) {
      throw new CtlError(
        'not-found',
        `No live request ${requestId} on this session (already answered, or the turn ended).`
      )
    }
    const after = this.deps.store.latestSeq(sessionId)
    if (pending.kind === 'permission') {
      const decision = optStr(args.decision)
      if (!decision || !(pending.options ?? []).includes(decision)) {
        throw new CtlError('usage', `Decision must be one of: ${(pending.options ?? []).join(', ')}`)
      }
      this.deps.api.respondPermission(sessionId, requestId, decision)
    } else {
      const picked = Array.isArray(args.options) ? args.options.map(String) : []
      this.deps.api.respondQuestion(sessionId, requestId, this.answersFor(pending, picked))
    }
    if (!args.wait) {
      return { session: await this.sessionObject(this.requireSession(sessionId)), after }
    }
    return this.waitFor(sessionId, after, secondsArg(args.timeout), signal)
  }

  /** Map `--option` ids onto the question(s) that own them. */
  private answersFor(pending: PendingRequest, picked: string[]): QuestionAnswer[] {
    const questions = pending.questions ?? []
    if (!picked.length) throw new CtlError('usage', 'Pass --option <id> to answer a question.')
    const answers: QuestionAnswer[] = questions.map((q) => ({ questionId: q.id, optionIds: [] }))
    for (const id of picked) {
      const i = questions.findIndex((q) => q.options.some((o) => o.id === id))
      if (i === -1) {
        const known = questions.flatMap((q) => q.options.map((o) => o.id)).join(', ')
        throw new CtlError('usage', `Unknown option "${id}". Options: ${known}`)
      }
      answers[i].optionIds.push(id)
    }
    return answers.filter((a) => a.optionIds.length)
  }

  /* ---------------- wait ---------------- */

  /**
   * Block until the turn that began after transcript seq `after` settles, the
   * session needs input, or `timeoutS` elapses. Turn-correlated: a
   * turn-complete at or before `after` never counts, so a stale one from the
   * previous turn cannot satisfy a wait on this one. `after: null` = whatever is
   * running NOW (nothing running -> reason "idle", never a replayed old result).
   */
  private waitFor(
    sessionId: string,
    after: number | null,
    timeoutS: number,
    signal: AbortSignal
  ): Promise<unknown> {
    const explicit = after !== null
    const cursor = after ?? this.deps.store.latestSeq(sessionId)
    return new Promise((resolve, reject) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const waiter: Waiter = { sessionId, check: () => void tryResolve() }
      const cleanup = (): void => {
        done = true
        if (timer) clearTimeout(timer)
        this.waiters.delete(waiter)
        signal.removeEventListener('abort', onAbort)
      }
      const finish = async (outcome: Outcome): Promise<void> => {
        if (done) return
        cleanup()
        try {
          resolve(await this.waitResult(sessionId, outcome))
        } catch (err) {
          reject(err)
        }
      }
      const tryResolve = async (): Promise<void> => {
        if (done) return
        try {
          const outcome = this.evaluate(sessionId, cursor, explicit)
          if (outcome) await finish(outcome)
        } catch (err) {
          if (done) return
          cleanup()
          reject(err)
        }
      }
      const onAbort = (): void => {
        if (done) return
        cleanup()
        reject(new CtlError('internal', 'caller went away'))
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort)
      this.waiters.add(waiter)
      void tryResolve()
      if (!done) {
        timer = setTimeout(() => void finish({ reason: 'timeout' }), timeoutS * 1000)
      }
    })
  }

  /** The state machine behind wait. null = keep waiting. */
  private evaluate(sessionId: string, after: number, explicit: boolean): Outcome | null {
    const { store } = this.deps
    const session = store.getSession(sessionId)
    if (!session) throw new CtlError('not-found', 'That session no longer exists.')
    const ended = store.firstEventOfKindsAfter(sessionId, after, ['turn-complete', 'exit'])
    // The transcript event is broadcast BEFORE sessionManager flips the status, so
    // resolving on the event alone returned a `session` still saying "running".
    // Hold the outcome until the flip lands: onSessionUpdated pokes us again.
    if (ended && (session.status === 'running' || session.status === 'starting')) return null
    if (ended) {
      if (ended.event.kind === 'exit') {
        return { reason: 'error', errorMessage: `the agent process exited (code ${ended.event.code})` }
      }
      if (ended.event.kind === 'turn-complete') {
        const ev = ended.event
        const interrupted = ev.isError && ev.errorMessage === 'interrupted'
        return {
          reason: ev.isError && !interrupted ? 'error' : 'turn-complete',
          result: cap(ev.result),
          isError: ev.isError && !interrupted,
          errorMessage: ev.isError && !interrupted ? ev.errorMessage : undefined,
          costUsd: ev.costUsd
        }
      }
    }
    if (session.status === 'archived') return { reason: 'archived' }
    const pending = this.livePending(sessionId)
    if (pending) return { reason: 'needs-input' }
    if (session.status === 'error') {
      return { reason: 'error', errorMessage: session.lastError ?? 'the session is in an error state' }
    }
    if (session.status === 'idle') {
      // nothing in flight. Asked about a specific turn that left no result behind,
      // the agent died or hang4r restarted mid-turn; asked about "now", just idle.
      return explicit
        ? {
            reason: 'error',
            errorMessage: 'the turn ended without a result (the agent exited or hang4r restarted)'
          }
        : { reason: 'idle' }
    }
    return null
  }

  private async waitResult(sessionId: string, o: Outcome): Promise<unknown> {
    const session = this.requireSession(sessionId)
    return {
      reason: o.reason,
      session: await this.sessionObject(session),
      result: o.result,
      isError: o.isError ?? o.reason === 'error',
      errorMessage: o.errorMessage,
      costUsd: o.costUsd
    }
  }

  /* ---------------- derived state ---------------- */

  /**
   * The request the session is blocked on RIGHT NOW: unresolved, newer than the
   * last turn-complete/exit, with a live adapter. A request from an ended turn
   * stays in the transcript forever, so "unresolved in the transcript" alone
   * would report phantom blocks and let `respond` claim success against nothing.
   */
  private livePending(sessionId: string): PendingRequest | null {
    const { store, sessions } = this.deps
    const session = store.getSession(sessionId)
    if (!session || (session.status !== 'running' && session.status !== 'starting')) return null
    if (!sessions.agentAlive(sessionId)) return null
    const resolved = new Set<string>()
    for (const e of store.iterateEventsBackward(sessionId)) {
      const ev = e.event
      if (ev.kind === 'turn-complete' || ev.kind === 'exit') return null
      if (ev.kind === 'permission-resolved' || ev.kind === 'question-resolved') {
        resolved.add(ev.requestId)
      } else if (ev.kind === 'permission-request' && !resolved.has(ev.requestId)) {
        return {
          requestId: ev.requestId,
          kind: 'permission',
          tool: ev.tool,
          summary: ev.summary,
          detail: ev.detail,
          options: ev.options
        }
      } else if (ev.kind === 'question-request' && !resolved.has(ev.requestId)) {
        return {
          requestId: ev.requestId,
          kind: 'question',
          summary: ev.title,
          questions: ev.questions.map((q) => ({
            id: q.id,
            text: q.prompt,
            options: q.options
          }))
        }
      }
    }
    return null
  }

  private async sessionObject(
    s: SessionMeta,
    opts?: { branch?: boolean }
  ): Promise<Record<string, unknown>> {
    const { store, settings, api } = this.deps
    const lastTurn = store.latestEventOfKind(s.id, 'turn-complete', Number.MAX_SAFE_INTEGER)
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      backend: s.backend,
      model: s.model,
      effort: settings.getSetting(`effort:${s.id}`)?.trim() || null,
      projectId: s.projectId,
      projectName: store.getProject(s.projectId)?.name ?? null,
      environment: s.environment,
      cwd: s.cwd,
      branch: opts?.branch ? await api.currentBranch(s.id) : null,
      permissionMode: s.permissionMode,
      origin: s.origin ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      pending: this.livePending(s.id),
      lastResult:
        lastTurn && lastTurn.event.kind === 'turn-complete' ? cap(lastTurn.event.result) ?? null : null,
      seq: store.latestSeq(s.id)
    }
  }

  /** The last few events as plain text, for `show`. */
  private recentEvents(sessionId: string): unknown[] {
    const out: { seq: number; ts: number; role: string; text: string }[] = []
    for (const e of this.deps.store.iterateEventsBackward(sessionId)) {
      const ev = e.event
      let item: { role: string; text: string } | null = null
      if (ev.kind === 'user-text') item = { role: 'user', text: shownUserText(ev) }
      else if (ev.kind === 'block-final' && ev.block.type === 'text') {
        item = { role: 'assistant', text: ev.block.text }
      } else if (ev.kind === 'block-final' && ev.block.type === 'tool_use') {
        item = { role: 'tool', text: `${ev.block.name} ${JSON.stringify(ev.block.input).slice(0, 200)}` }
      } else if (ev.kind === 'permission-request') {
        item = { role: 'system', text: `permission requested: ${ev.summary}` }
      } else if (ev.kind === 'question-request') {
        item = { role: 'system', text: `question: ${ev.title ?? ev.questions[0]?.prompt ?? ''}` }
      } else if (ev.kind === 'turn-complete') {
        item = { role: 'system', text: ev.isError ? `turn failed: ${ev.errorMessage ?? ''}` : 'turn complete' }
      }
      if (item) out.push({ seq: e.seq, ts: e.ts, role: item.role, text: cap(item.text) ?? '' })
      if (out.length >= SHOW_EVENTS) break
    }
    return out.reverse()
  }

  /** seq of the first user-text after `base` (the turn this call just started).
   *  Codex echoes it asynchronously, so give it a moment. */
  private async userTextSeq(sessionId: string, base: number): Promise<number | null> {
    for (let i = 0; i < 20; i++) {
      const e = this.deps.store.firstEventOfKindsAfter(sessionId, base, ['user-text'])
      if (e) return e.seq
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  private requireSession(sessionId: string): SessionMeta {
    const s = this.deps.store.getSession(sessionId)
    if (!s) throw new CtlError('not-found', `No session ${sessionId}.`)
    return s
  }

  /** id, then exact name, then absolute path, else the project containing `cwd`. */
  private resolveProject(ref?: string, cwd?: string): { id: string; path: string } {
    const projects = this.deps.store.listProjects()
    if (ref) {
      const byId = projects.find((p) => p.id === ref)
      if (byId) return byId
      const byName = projects.filter((p) => p.name === ref)
      if (byName.length > 1) {
        throw new CtlError('usage', `Project name "${ref}" is ambiguous; pass the id or path.`)
      }
      if (byName.length === 1) return byName[0]
      if (isAbsolute(ref)) {
        const abs = resolvePath(ref)
        const byPath = projects.find((p) => resolvePath(p.path) === abs)
        if (byPath) return byPath
      }
      throw new CtlError('not-found', `No project "${ref}" (projects must already be added in hang4r).`)
    }
    if (cwd && isAbsolute(cwd)) {
      const inside = projects
        .filter((p) => cwd === p.path || cwd.startsWith(p.path + sep))
        .sort((a, b) => b.path.length - a.path.length)
      if (inside[0]) return inside[0]
    }
    throw new CtlError('usage', 'Pass --project, or run from inside a project hang4r knows.')
  }
}

interface Outcome {
  reason: WaitReason
  result?: string
  isError?: boolean
  errorMessage?: string
  costUsd?: number
}

function toCtlError(err: unknown): CtlError {
  if (err instanceof CtlError) return err
  if (isSessionBusyError(err)) {
    return new CtlError('busy', 'Session is busy: a turn is already running.')
  }
  if (isWorktreeMissingError(err)) {
    return new CtlError('worktree-missing', err instanceof Error ? err.message : String(err))
  }
  return new CtlError('internal', err instanceof Error ? err.message : String(err))
}

/** "cli:<caller>" — the caller label is cosmetic, so it is scrubbed, not trusted */
function originOf(caller: string | undefined): string {
  return caller ? `cli:${caller}` : 'cli'
}

function cleanCaller(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const clean = v.replace(/[^\w.@:-]/g, '').slice(0, 40)
  return clean || undefined
}

function cap(v: string | undefined): string | undefined {
  if (v === undefined) return undefined
  return v.length > RESULT_CAP ? v.slice(0, RESULT_CAP) + '…' : v
}

function reqStr(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new CtlError('usage', `Missing ${name}.`)
  return v
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** --timeout seconds: default 600, capped at 3600, 0 = poll once */
function secondsArg(v: unknown): number {
  if (v === undefined || v === null || v === '') return DEFAULT_WAIT_S
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new CtlError('usage', '--timeout must be a number of seconds')
  return Math.min(n, MAX_WAIT_S)
}
