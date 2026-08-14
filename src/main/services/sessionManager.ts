import type {
  AgentEvent,
  BackendId,
  ChangedFile,
  DiffScope,
  NewSessionRequest,
  PermissionMode,
  PromptFile,
  PromptImage,
  QuestionAnswer,
  ReviewComment,
  ScopedFiles,
  ScopeSummary,
  SessionEvent,
  SessionMeta
} from '../../shared/protocol'
import { findBinary } from './binaryDiscovery'
import { buildHandoffSeed, backendLabel } from './handoff'
import { ClaudeAdapter } from './adapters/claudeAdapter'
import { CodexAdapter } from './adapters/codexAdapter'
import { CursorAdapter } from './adapters/cursorAdapter'
import { FakeAdapter } from './adapters/fakeAdapter'
import type { AgentAdapter } from './adapters/types'

/** E2E/loop verification mode: use a deterministic in-process agent. */
const FAKE_AGENT = process.env.HANG4R_FAKE_AGENT === '1'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { ClaudeImport, parseRewindAnchor } from './claudeImport'
import { CodexImport } from './codexImport'
import { CursorAgentImport } from './cursorAgentImport'
import { rewindStrategyFor, turnsToRewind } from './rewindStrategy'
import { resolveShell } from './ptyService'
import { GitService, DEFAULT_WORKTREE_DIR } from './gitService'
import {
  RemoteService,
  ensureMaster,
  closeMaster,
  closeTunnels,
  LocalExec,
  sshExec,
  type Exec
} from './remoteService'
import type { Store } from './store'
import type { SettingsService } from './settingsService'

type Broadcast = {
  agentEvent(ev: SessionEvent): void
  sessionUpdated(session: SessionMeta): void
}

/**
 * Owns session lifecycle: spawning adapters, routing their events to the
 * store (transcript) and the renderer (live), keeping SessionMeta status in
 * sync, isolating worktree sessions, and committing per-turn checkpoints.
 */
/** max CONSECUTIVE auto-continues (poisoned-tail recovery) before we stop and
 *  wait for a manual prompt — a repeated-crash loop can't burn turns forever. */
const MAX_AUTO_CONTINUE = 3

export class SessionManager {
  private adapters = new Map<string, AgentAdapter>()
  /** monotonically increasing turn counter per session, for commit messages */
  private turnCounters = new Map<string, number>()
  /** setup-script outcome per session (true = ran clean) — dev-process
   *  auto-start waits on this so it never launches into a half-provisioned tree */
  private setupRuns = new Map<string, Promise<boolean>>()
  /** permission mode each live adapter was spawned with — a mid-turn mode change
   *  is deferred until turn-complete, where we compare against the session's
   *  (already-updated) mode and dispose the stale adapter if they diverge. */
  private spawnedPermissionMode = new Map<string, PermissionMode>()
  /** CONSECUTIVE auto-continues of a poisoned tail since the last MANUAL prompt —
   *  capped at MAX_AUTO_CONTINUE so a repeated-crash loop can never burn turns
   *  forever. Reset only when the user manually sends something (prompt auto=false). */
  private autoContinueAttempts = new Map<string, number>()
  /** sessions whose last turn ended because the USER interrupted a tool (pressed
   *  stop). A deliberate stop means "I'm taking over" — don't auto-continue over
   *  them (Angel). Cleared when the user sends the next manual prompt, or on any
   *  clean turn. Separate from the poison recovery, which is for CLI-side aborts. */
  private userInterrupted = new Set<string>()

  constructor(
    private store: Store,
    private settings: SettingsService,
    private broadcast: Broadcast,
    /** per-session env for the agent-drivable browser CLI (socket/token/PATH shim);
     *  omitted for ssh sessions (the remote host can't reach the local socket) */
    private browserEnv?: (sessionId: string) => Record<string, string>
  ) {
    // On startup, any session left 'running'/'starting' has no live adapter (the
    // process died with the app) — reset it to idle so the composer and Stop
    // aren't permanently stuck. A follow-up prompt respawns via --resume.
    for (const s of store.listSessions()) {
      if (s.status === 'running' || s.status === 'starting') {
        store.updateSession(s.id, { status: 'idle' })
      }
    }
  }

  async createSession(req: NewSessionRequest): Promise<SessionMeta> {
    const project = this.store.getProject(req.projectId)
    if (!project) throw new Error(`Unknown project: ${req.projectId}`)

    const title = req.title?.trim() || (req.firstPrompt ? deriveTitle(req.firstPrompt) : 'New session')

    let cwd = project.path
    let baseRef = 'HEAD'
    const environment = req.environment

    if (req.environment === 'ssh') {
      // remote session (docs/ssh-design.md): cwd is the REMOTE directory; the
      // adapter, not this process, touches it. Preflight so a bad host fails
      // the dialog with a real reason instead of a dead session.
      const host = this.remoteHost(req.remoteHostId)
      if (!host)
        throw new Error('Pick an SSH host (configure one in Settings → Remote first).')
      if (req.backend !== 'claude')
        throw new Error('SSH sessions support the Claude backend only (for now).')
      const test = await RemoteService.testHost(host.host)
      if (!test.reachable)
        throw new Error(`Can't reach ${host.host}: ${test.error ?? 'unknown ssh error'}`)
      if (!test.claudeVersion)
        throw new Error(
          `${host.host} is reachable but has no claude CLI on its PATH. Install + log in Claude Code on the remote.`
        )
      await ensureMaster(host.host).catch(() => undefined) // reuse auth for the session's lifetime
      cwd = (req.remoteDir?.trim() || host.dir || '~').replace(/\/+$/, '') || '~'
      baseRef = ''
    } else if (req.environment === 'worktree') {
      if (!(await GitService.isRepo(project.path))) {
        throw new Error('Worktree isolation requires the project to be a git repository.')
      }
      const wt = await GitService.createWorktree(
        project.path,
        worktreeNameFor(title),
        this.worktreeDir(project.id),
        this.branchPrefix(project.id)
      )
      cwd = wt.worktreePath
      baseRef = wt.baseBranch
    } else if (await GitService.isRepo(project.path)) {
      baseRef = 'HEAD'
    } else {
      // non-git local session: no diff base
      baseRef = ''
    }

    const session = this.store.createSession({
      projectId: req.projectId,
      backend: req.backend,
      title,
      model: req.model,
      cwd,
      environment,
      baseRef,
      permissionMode: req.permissionMode,
      remoteHostId: req.environment === 'ssh' ? req.remoteHostId : undefined
    })

    const firstPrompt = req.firstPrompt?.trim() ? req.firstPrompt : null

    // The setup script runs FULLY in the background (Angel's call, Jul 16 —
    // an earlier version gated the first prompt on it, which parked the agent
    // for the length of an `npm install`). The agent starts immediately; the
    // transcript setup-notes show progress and any failure. Anything that
    // genuinely needs a PROVISIONED tree (dev-process auto-start) awaits
    // setupResult() instead of blocking the session.
    if (environment === 'worktree' && this.hasSetupScript(project.id)) {
      this.setupRuns.set(
        session.id,
        this.runSetup(session.id, cwd, project.path, project.id)
      )
    }

    const adapter = this.spawnAdapter(session)
    this.adapters.set(session.id, adapter)
    if (firstPrompt) {
      // carry any modal-attached files/images into the first turn — same shape as
      // SessionManager.prompt: agent-facing text + images + the display/card echo.
      // Materialize images to disk first so the agent gets a real file path (not
      // just the vision block); the echo keeps the un-noted text.
      const agentText = this.writeImageAttachments(session, firstPrompt, req.firstImages)
      const echoDisplay =
        req.firstDisplayText ?? (agentText !== firstPrompt ? firstPrompt : undefined)
      adapter.prompt(
        agentText,
        req.firstImages,
        req.firstFiles?.length || echoDisplay !== undefined
          ? { files: req.firstFiles, displayText: echoDisplay }
          : undefined
      )
      this.updateSession(session.id, { status: 'running' })
    } else {
      // No first turn: the session (worktree, adapter) is live but idle, ready
      // for the user's first prompt from the tile composer. The adapter is
      // already spawned so that prompt streams without a re-spawn.
      this.updateSession(session.id, { status: 'idle' })
    }
    return this.store.getSession(session.id)!
  }

  /**
   * TRUE-resume an existing Claude Code session (started in the terminal or
   * elsewhere) by its backend id, in its ORIGINAL working directory — so it
   * continues from where it left off with full context, not a re-seeded replay.
   * Registers the folder as a workspace if it isn't one yet.
   */
  async resumeExternalClaudeSession(
    externalId: string,
    originalCwd: string | undefined,
    name: string
  ): Promise<SessionMeta> {
    const cwd = originalCwd && existsSync(originalCwd) ? originalCwd : homedir()
    // find-or-create the workspace that owns this dir (fixes 'wrong workspace')
    const projects = this.store.listProjects()
    const project =
      projects.find((p) => p.path === cwd) ??
      projects.find((p) => cwd.startsWith(p.path + '/')) ??
      this.store.createProject(cwd)
    const isRepo = await GitService.isRepo(cwd)
    const session = this.store.createSession({
      projectId: project.id,
      backend: 'claude',
      title: `↳ ${name.slice(0, 78) || 'Resumed session'}`,
      model: undefined,
      cwd,
      environment: 'local', // resume in place, not a fresh worktree
      baseRef: isRepo ? 'HEAD' : '',
      permissionMode: 'acceptEdits'
    })
    this.updateSession(session.id, { backendSessionId: externalId })

    // replay the prior conversation into the hang4r view so it isn't empty — the
    // backend has the full context via --resume; this makes it VISIBLE. Cap the
    // display to the most recent messages to keep the transcript snappy.
    const history = ClaudeImport.getTranscript(externalId)
    const shown = history.slice(-40)
    if (history.length > shown.length) {
      this.handleAgentEvent(session.id, {
        kind: 'user-text',
        text: `— resumed: ${history.length - shown.length} earlier message(s) hidden —`
      })
    }
    for (const m of shown) {
      if (m.role === 'user') {
        this.handleAgentEvent(session.id, { kind: 'user-text', text: m.text })
      } else {
        this.handleAgentEvent(session.id, {
          kind: 'block-final',
          messageId: randomUUID(),
          blockIndex: 0,
          block: { type: 'text', text: m.text },
          parentToolUseId: null
        })
      }
    }

    const adapter = this.spawnAdapter({ ...session, backendSessionId: externalId }, externalId)
    this.adapters.set(session.id, adapter)
    // no auto-prompt: the conversation is restored; the user continues it
    this.updateSession(session.id, { status: 'idle' })
    return this.store.getSession(session.id)!
  }

  async resumeExternalCodexSession(
    externalId: string,
    originalCwd: string | undefined,
    name: string
  ): Promise<SessionMeta> {
    const cwd = originalCwd && existsSync(originalCwd) ? originalCwd : homedir()
    const projects = this.store.listProjects()
    const project =
      projects.find((p) => p.path === cwd) ??
      projects.find((p) => cwd.startsWith(p.path + '/')) ??
      this.store.createProject(cwd)
    const isRepo = await GitService.isRepo(cwd)
    const session = this.store.createSession({
      projectId: project.id,
      backend: 'codex',
      title: `↳ ${name.slice(0, 78) || 'Resumed Codex session'}`,
      model: undefined,
      cwd,
      environment: 'local',
      baseRef: isRepo ? 'HEAD' : '',
      permissionMode: 'acceptEdits'
    })
    this.updateSession(session.id, { backendSessionId: externalId })

    const history = CodexImport.getTranscript(externalId)
    const shown = history.slice(-40)
    if (history.length > shown.length) {
      this.handleAgentEvent(session.id, {
        kind: 'user-text',
        text: `— resumed: ${history.length - shown.length} earlier message(s) hidden —`
      })
    }
    for (const m of shown) {
      if (m.role === 'user') {
        this.handleAgentEvent(session.id, { kind: 'user-text', text: m.text })
      } else {
        this.handleAgentEvent(session.id, {
          kind: 'block-final',
          messageId: randomUUID(),
          blockIndex: 0,
          block: { type: 'text', text: m.text },
          parentToolUseId: null
        })
      }
    }
    const usage = CodexImport.latestUsage(externalId)
    if (usage) this.handleAgentEvent(session.id, usage)

    const adapter = this.spawnAdapter({ ...session, backendSessionId: externalId }, externalId)
    this.adapters.set(session.id, adapter)
    this.updateSession(session.id, { status: 'idle' })
    return this.store.getSession(session.id)!
  }

  async resumeExternalCursorSession(
    externalId: string,
    originalCwd: string | undefined,
    name: string
  ): Promise<SessionMeta> {
    const cwd = originalCwd && existsSync(originalCwd) ? originalCwd : homedir()
    const projects = this.store.listProjects()
    const project =
      projects.find((p) => p.path === cwd) ??
      projects.find((p) => cwd.startsWith(p.path + '/')) ??
      this.store.createProject(cwd)
    const isRepo = await GitService.isRepo(cwd)
    const session = this.store.createSession({
      projectId: project.id,
      backend: 'cursor',
      title: `↳ ${name.slice(0, 78) || 'Resumed Cursor session'}`,
      model: undefined,
      cwd,
      environment: 'local',
      baseRef: isRepo ? 'HEAD' : '',
      permissionMode: 'acceptEdits'
    })
    this.updateSession(session.id, { backendSessionId: externalId })

    const history = CursorAgentImport.getTranscript(externalId)
    const shown = history.slice(-40)
    if (history.length > shown.length) {
      this.handleAgentEvent(session.id, {
        kind: 'user-text',
        text: `— resumed: ${history.length - shown.length} earlier message(s) hidden —`
      })
    }
    for (const m of shown) {
      if (m.role === 'user') {
        this.handleAgentEvent(session.id, { kind: 'user-text', text: m.text })
      } else {
        this.handleAgentEvent(session.id, {
          kind: 'block-final',
          messageId: randomUUID(),
          blockIndex: 0,
          block: { type: 'text', text: m.text },
          parentToolUseId: null
        })
      }
    }

    const adapter = this.spawnAdapter({ ...session, backendSessionId: externalId }, externalId)
    this.adapters.set(session.id, adapter)
    this.updateSession(session.id, { status: 'idle' })
    return this.store.getSession(session.id)!
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: PromptImage[],
    files?: PromptFile[],
    displayText?: string,
    auto = false
  ): Promise<void> {
    // a MANUAL prompt (you stepping in) re-arms auto-continue: it clears the
    // consecutive-auto counter so recovery is available again. An auto-continue
    // (auto=true) does NOT, so a repeated-crash loop stays capped. It also clears
    // the "you interrupted this" flag — sending a real prompt IS taking over.
    if (!auto) {
      this.autoContinueAttempts.delete(sessionId)
      this.userInterrupted.delete(sessionId)
    }
    // pull in any turns taken in an external interactive CLI (/remote-control)
    // BEFORE resuming — adoption switches backendSessionId to the fork's tip,
    // so this turn continues from the conversation INCLUDING those turns
    try {
      await this.resyncExternal(sessionId)
    } catch {
      /* re-sync must never block a prompt */
    }
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)

    // RECOVERY: if the tip is POISONED — the last turn aborted mid-tool, leaving
    // tool_use blocks with no tool_result (killed subagents, or a turn aborted in
    // an EXTERNAL interactive CLI adopted via resyncExternal) — a plain --resume
    // FAILS: the CLI refuses the invalid conversation and every follow-up re-errors
    // with error_during_execution (Angel: "we get that error a lot", "after an
    // Interactive CLI event"). We can't rely on our OWN status==='error': the
    // interactive-CLI abort is adopted WITHOUT flipping our status, so also check
    // the jsonl tail for a dangling tool_use. Fork-truncate PAST the poisoned turn.
    //
    // Computed BEFORE the adapter check: the interactive-CLI case leaves the
    // adapter ALIVE, so a respawn-only recovery never fired — the live adapter
    // just --resumed the poison and re-errored. When idle (never a live turn), we
    // drop the stale adapter so it respawns recovering.
    const idle = session.status !== 'running' && session.status !== 'starting'
    // HEAL BEFORE RESUME: a poisoned tail (a dangling tool_use) makes a plain
    // --resume fail. PREFER repairing the jsonl in place — append the missing
    // tool_result so the file is valid again — over fork-truncating past the
    // poison: the fork LOSES the aborted turn, the heal KEEPS it. Only fall back
    // to the fork-past anchor when the heal can't fix the file.
    const poisoned =
      session.backend === 'claude' &&
      !!session.backendSessionId &&
      ClaudeImport.tailIsPoisoned(session.backendSessionId)
    const healed = poisoned && ClaudeImport.healPoison(session.backendSessionId!)
    const needsRecovery = !healed && (session.status === 'error' || poisoned)
    const recoverAt = needsRecovery ? this.recoveryAnchor(session) : null

    let adapter = this.adapters.get(sessionId)
    // Drop a live/idle adapter when we're going to fork-recover OR we just healed
    // the jsonl: a live -p process holds the OLD conversation in memory and never
    // re-reads the file, so it would --resume from the stale (poisoned) history.
    // Respawning makes --resume re-read the repaired transcript.
    if (adapter && (recoverAt || healed) && idle) {
      adapter.dispose()
      this.adapters.delete(sessionId)
      adapter = undefined
    }
    if (!adapter) {
      // Re-spawn (e.g. after app restart, or the recovery drop above): a PROMPT is
      // an explicit "continue here", so recreate the worktree if it was cleaned
      // (recreate=true) — passive access leaves it dropped, but working rebuilds it.
      await this.ensureWorkdir(sessionId, true)
      const fresh = recoverAt
        ? this.spawnAdapter(session, session.backendSessionId!, true, recoverAt)
        : this.spawnAdapter(session, session.backendSessionId ?? undefined)
      this.adapters.set(sessionId, fresh)
      adapter = fresh
    }
    // Materialize any attached images to a session-readable scratch file and add
    // the path to the agent-facing text (the base64 vision block still goes too),
    // so file-based tools have something to point at. The echo keeps the original
    // (un-noted) text — the transcript already shows the image thumbnails.
    const agentText = this.writeImageAttachments(session, text, images)
    const echoDisplay = displayText ?? (agentText !== text ? text : undefined)
    adapter.prompt(
      agentText,
      images,
      files?.length || echoDisplay !== undefined
        ? { files, displayText: echoDisplay }
        : undefined
    )
    this.updateSession(sessionId, { status: 'running', lastError: null })
  }

  /**
   * Materialize prompt image attachments to a session-readable scratch file and
   * return the agent-facing text with a `[Attached image saved to: <path>]` note
   * per image — while the caller STILL sends the base64 vision block. Fixes: an
   * attached image reached the model only as rendered pixels with no file behind
   * it, so any file-based tool (upload API, image processing) had nothing to
   * point at (Angel, media-gen project).
   *
   * Files land in `<cwd>/.hang4r/attachments/` so the agent's OWN shell can read
   * them (materialized from the base64 bytes hang4r already holds — the picked
   * path is unreliable: Photos-library / iCloud originals aren't readable). A
   * self-ignoring `<cwd>/.hang4r/.gitignore` ('*' matches every file, itself
   * included) keeps the whole subtree out of `git status`, the diff review, and
   * per-turn checkpoints without touching the user's tracked .gitignore.
   *
   * Scoped to LOCAL Claude sessions: ssh has no local fs on the adapter side
   * (vision-only, matching external-attachment ssh scoping) and only the Claude
   * backend takes base64 image blocks today. Best-effort — a write failure never
   * blocks the turn; the vision block still flows.
   */
  private writeImageAttachments(
    session: SessionMeta,
    text: string,
    images?: PromptImage[]
  ): string {
    if (!images?.length) return text
    if (session.backend !== 'claude' || session.environment === 'ssh') return text
    const cwd = session.cwd
    if (!cwd || !existsSync(cwd)) return text
    try {
      const dir = join(cwd, '.hang4r', 'attachments')
      mkdirSync(dir, { recursive: true })
      const ignore = join(cwd, '.hang4r', '.gitignore')
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
      const stamp = Date.now()
      const notes: string[] = []
      images.forEach((img, i) => {
        const file = join(dir, `img-${stamp}-${i}.${imageExt(img.mediaType)}`)
        writeFileSync(file, Buffer.from(img.base64, 'base64'))
        notes.push(`[Attached image saved to: ${file}]`)
      })
      return notes.length ? `${text}\n\n${notes.join('\n')}` : text
    } catch {
      // never block a turn on an attachment write; the vision block still goes
      return text
    }
  }

  /**
   * The parentUuid to `--resume-session-at` so a fork drops the LAST (aborted)
   * turn: find the last user message in our transcript, then its parent in the
   * jsonl. null if we can't locate it (→ caller falls back to a plain resume,
   * no worse than before). Claude-only; other backends resume differently.
   */
  private recoveryAnchor(session: SessionMeta): string | null {
    if (session.backend !== 'claude' || !session.backendSessionId) return null
    // Prefer anchoring on the POISON itself: retry prompts ("continue") pile up
    // after the dangling tool_use, so a last-user-text anchor drifts past it and
    // the fork keeps the poison. The poison-based anchor targets the aborted turn
    // directly. Fall back to last-user-text for non-poison errors / unresolvable.
    const byPoison = ClaudeImport.poisonRewindAnchor(session.backendSessionId)
    if (byPoison) return byPoison
    // Poisoned tail but no resolvable fork point: DON'T fall through to the
    // last-user-text anchor below — retry "continue"s pile up AFTER the dangling
    // tool_use, so that anchor drifts PAST the poison → the fork keeps it (still
    // error_during_execution) AND drops real conversation. A plain resume (null
    // anchor) at least doesn't lose turns. Only the last-user-text path is for our
    // OWN aborted turns (status==='error', not poisoned), where it's correct.
    if (ClaudeImport.tailIsPoisoned(session.backendSessionId)) return null
    const events = this.store.getEvents(session.id)
    let lastUserText: string | null = null
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i].event
      // include external-turn USER messages: when the poison came from an
      // interactive CLI, the last prompt is an external-turn, not a user-text —
      // anchoring only on user-text would truncate to a stale older prompt
      if (ev.kind === 'user-text' || (ev.kind === 'external-turn' && ev.role === 'user')) {
        lastUserText = ev.text
        break
      }
    }
    if (!lastUserText) return null
    try {
      const anchor = ClaudeImport.findRewindAnchor(session.backendSessionId, lastUserText, 0)
      return anchor?.parentUuid ?? null
    } catch {
      return null
    }
  }

  /**
   * The renderer poll (every ~2.5s while visible) calls this. Re-sync any external
   * interactive-CLI turns, then — if that left a POISONED tail (an external turn
   * aborted mid-tool) — auto-continue past it so the user doesn't have to type
   * "continue" (Angel's chosen behavior).
   */
  async resyncAndRecover(sessionId: string): Promise<number> {
    const n = await this.resyncExternal(sessionId)
    await this.maybeAutoContinue(sessionId)
    return n
  }

  /**
   * Auto-recover a session whose jsonl tail is POISONED because an interactive-CLI
   * turn aborted mid-tool (a dangling tool_use the CLI refuses to --resume → the
   * next turn re-errors with error_during_execution). Fork past the poison and
   * resume automatically. SCOPED to the idle/external case only, so it never
   * changes how our OWN errored turns behave (those keep manual recovery).
   *
   * LOOP SAFETY (Angel): capped at MAX_AUTO_CONTINUE CONSECUTIVE auto-continues,
   * and the counter resets ONLY when the user manually sends something (see
   * prompt(auto)). So if the recovery keeps re-crashing — even when each attempt
   * "succeeds" and the external CLI just re-poisons — it stops after a few tries
   * and waits for you, instead of auto-continuing (and burning turns) forever.
   */
  private async maybeAutoContinue(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session || session.backend !== 'claude' || !session.backendSessionId) return
    if (this.settings.getSetting('autoContinue') === 'off') return // you turned auto-recovery off
    if (session.status === 'running' || session.status === 'starting') return
    if (session.status === 'error') return // our own error → existing manual recovery
    if (this.userInterrupted.has(sessionId)) return // you deliberately stopped it — don't drive over you
    // Only auto-continue when we can compute a CLEAN fork point PAST the dangling
    // tool_use. tailIsPoisoned alone isn't enough: if the poison can't be resolved
    // to a fork anchor (poison in the first turn, broken parent chain), a resume
    // either re-keeps the poison (drift) or plain-resumes it — EITHER WAY it just
    // re-errors, so firing "continue" burns an attempt for nothing. Wait for you
    // instead. (poisonRewindAnchor != null ⇒ poisoned AND cleanly forkable.)
    if (!ClaudeImport.poisonRewindAnchor(session.backendSessionId)) return
    const count = this.autoContinueAttempts.get(sessionId) ?? 0
    if (count >= MAX_AUTO_CONTINUE) return // too many in a row without you stepping in — stop
    this.autoContinueAttempts.set(sessionId, count + 1)
    // prompt() runs the full fork-past-poison recovery; "continue" is the minimal
    // resume input, kept visible in the transcript so the auto-recovery is honest.
    // auto=true so it does NOT reset the consecutive-auto counter.
    try {
      await this.prompt(sessionId, 'continue', undefined, undefined, undefined, true)
    } catch {
      /* couldn't spawn — leave it; the user can retry manually */
    }
  }

  /**
   * Transcript re-sync: turns taken in an EXTERNAL interactive CLI resumed on
   * this conversation (the /remote-control terminal) live in a forked session
   * file hang4r never streamed. Import everything after our watermark as
   * external-turn events and ADOPT the fork's id, so our next --resume
   * continues from the true tip. Returns how many messages were imported.
   */
  async resyncExternal(sessionId: string): Promise<number> {
    const s = this.store.getSession(sessionId)
    if (!s || s.environment === 'ssh') return 0
    if (s.status === 'running' || s.status === 'starting') return 0
    if (!s.backendSessionId) return 0
    // After a turn that ended in ERROR, the tail of the jsonl is OUR OWN
    // aborted turn — importing those lines as "external" re-labels the user's
    // and agent's messages as interactive-CLI turns and duplicates the
    // conversation (Angel hit this after an error_during_execution). Skip the
    // import and just advance the watermark past the aborted turn so the next
    // clean turn re-syncs normally.
    if (s.status === 'error' && s.backend === 'claude') {
      const uuid = ClaudeImport.tailUuid(s.backendSessionId)
      if (uuid) {
        this.settings.setSetting(
          `syncWatermark:${sessionId}`,
          JSON.stringify({ uuid, fileId: s.backendSessionId, turnEndedAt: Date.now() })
        )
      }
      return 0
    }
    if (s.backend === 'codex') {
      const usage = CodexImport.latestUsage(s.backendSessionId)
      if (!usage || usage.kind !== 'usage') return 0
      const syncKey = `codexUsageSync:${sessionId}`
      const signature = `${usage.contextTokens ?? 0}:${usage.contextWindowTokens ?? 0}`
      if (this.settings.getSetting(syncKey) === signature) return 0
      this.settings.setSetting(syncKey, signature)
      this.handleAgentEvent(sessionId, usage)
      return 1
    }
    if (s.backend !== 'claude') return 0
    const raw = this.settings.getSetting(`syncWatermark:${sessionId}`)
    if (!raw) return 0
    let wm: { uuid: string; fileId: string; turnEndedAt?: number }
    try {
      wm = JSON.parse(raw)
    } catch {
      return 0
    }
    if (!wm?.uuid || wm.fileId !== s.backendSessionId) {
      // stale watermark (hang4r turned since it was recorded) — refresh, no import
      this.recordSyncWatermark(sessionId, 0)
      return 0
    }
    // PRIMARY: `claude --resume <id>` APPENDS to the same session file (no new
    // id) — external turns are simply the lines after our watermark.
    const own = ClaudeImport.sessionFile(s.backendSessionId)
    let msgs = own ? ClaudeImport.messagesAfter(own, wm.uuid) : []
    let adoptId: string | null = null
    if (!msgs.length) {
      // FALLBACK: an external `--fork-session` run lands in a NEW file that
      // contains our watermark uuid — import it and adopt the fork's id
      const cont = ClaudeImport.findContinuation(s.cwd, wm.uuid, wm.fileId)
      if (cont) {
        msgs = ClaudeImport.messagesAfter(cont.path, wm.uuid)
        adoptId = cont.id
      }
    }
    // The CLI flushes its final assistant line LATE — the uuid watermark can
    // land one line short, which would re-import hang4r's OWN last reply as
    // "external" (caught by QA hunt 7, and again when a user INTERRUPT left the
    // watermark stale → Angel's phantom "⇄ interactive CLI" fork). Timestamp
    // guard: our own lagging lines were written BEFORE turn end; genuinely
    // external turns come after. Relies on turnEndedAt being the CURRENT turn's
    // end — recordSyncWatermark now writes it SYNCHRONOUSLY at turn-complete so
    // a resync poll can't slip in with a stale (previous-turn) watermark.
    msgs = ClaudeImport.filterExternalTurns(msgs, wm.turnEndedAt)
    if (!msgs.length) return 0
    for (const m of msgs) {
      this.handleAgentEvent(sessionId, {
        kind: 'external-turn',
        role: m.role,
        text: m.text,
        at: m.at
      })
    }
    if (adoptId) this.updateSession(sessionId, { backendSessionId: adoptId })
    // ALWAYS drop the idle adapter after an import: a live -p process holds the
    // conversation IN MEMORY and never re-reads the jsonl — without a re-spawn
    // (--resume re-reads the file) the next turn wouldn't know the external
    // turns even though they're in the transcript (caught by the real-CLI probe)
    this.adapters.get(sessionId)?.dispose()
    this.adapters.delete(sessionId)
    const tipId = adoptId ?? s.backendSessionId
    const tail = ClaudeImport.tailUuid(tipId)
    if (tail) {
      this.settings.setSetting(
        `syncWatermark:${sessionId}`,
        JSON.stringify({ uuid: tail, fileId: tipId, turnEndedAt: Date.now() })
      )
    }
    return msgs.length
  }

  /**
   * Record the sync watermark = tail uuid of the current backend session file
   * plus WHEN the turn ended — the timestamp is the dedup backstop when the
   * uuid lands a line short of the (late-flushed) final assistant message.
   */
  private recordSyncWatermark(sessionId: string, delayMs = 600): void {
    const turnEndedAt = Date.now()
    const write = (): void => {
      const s = this.store.getSession(sessionId)
      if (!s?.backendSessionId || s.backend !== 'claude' || s.environment === 'ssh') return
      const uuid = ClaudeImport.tailUuid(s.backendSessionId)
      if (uuid) {
        this.settings.setSetting(
          `syncWatermark:${sessionId}`,
          JSON.stringify({ uuid, fileId: s.backendSessionId, turnEndedAt })
        )
      }
    }
    // delayMs<=0: write SYNCHRONOUSLY. turn-complete flips status→idle and then
    // records the watermark with NO await between; a setTimeout(0) here opened a
    // gap where a resync poll (fires once status isn't 'running') read the STALE
    // previous-turn watermark and re-imported our own just-ended turn as an
    // "⇄ interactive CLI" turn — the phantom fork Angel saw after interrupting a
    // tool. A synchronous write keeps turnEndedAt current before any poll runs.
    // The delayed call still catches the CLI's late-flushed final line.
    if (delayMs <= 0) write()
    else setTimeout(write, delayMs)
  }

  /** whether a live agent (CLI) process exists — background tasks can't outlive it */
  agentAlive(sessionId: string): boolean {
    return this.adapters.has(sessionId)
  }

  interrupt(sessionId: string): void {
    const adapter = this.adapters.get(sessionId)
    if (adapter) {
      adapter.interrupt()
    } else {
      // no live adapter (e.g. the session was mid-turn when the app restarted) —
      // just unstick the UI so the user can send again.
      this.updateSession(sessionId, { status: 'idle' })
    }
  }

  /**
   * Hand THIS conversation to an external interactive CLI (/remote-control):
   * stop hang4r's OWN -p process so it's no longer a second writer on the same
   * session file. Two writers on one jsonl is exactly what collides into
   * error_during_execution AND drifts the transcript into two conversations
   * (Angel's remote-control complaint). After this the terminal CLI is the sole
   * driver; resyncExternal mirrors its turns back into the desktop transcript, and
   * hang4r takes control back automatically the next time the user prompts from
   * the composer (which respawns the adapter). The watermark is reset to the
   * current tail so the mirror picks up cleanly from where the handoff happened.
   */
  releaseForExternal(sessionId: string): void {
    const adapter = this.adapters.get(sessionId)
    if (adapter) {
      try {
        adapter.interrupt() // stop our in-flight turn cleanly (no dangling tool_use)
      } catch {
        /* best-effort */
      }
      adapter.dispose()
      this.adapters.delete(sessionId)
    }
    this.spawnedPermissionMode.delete(sessionId)
    this.updateSession(sessionId, { status: 'idle', lastError: null })
    this.recordSyncWatermark(sessionId, 0)
  }

  /** Poll until the session is no longer 'running' (interrupt settled) or the
   *  timeout passes — an interrupt is async (Cursor: SIGTERM→SIGKILL escalation). */
  private async waitForTurnEnd(sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.store.getSession(sessionId)?.status !== 'running') return
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  rename(sessionId: string, title: string): void {
    const clean = title.trim()
    if (clean) {
      this.updateSession(sessionId, { title: clean.slice(0, 120) })
      // push to the backend too (Codex thread/name/set)
      this.adapters.get(sessionId)?.setTitle?.(clean)
    }
  }

  respondPermission(sessionId: string, requestId: string, decision: string): void {
    this.adapters.get(sessionId)?.respondPermission?.(requestId, decision)
  }

  respondQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): void {
    this.adapters.get(sessionId)?.respondQuestion?.(requestId, answers)
  }

  /** Fork a session: same context, new backend session id, own worktree. */
  async duplicateSession(sessionId: string): Promise<SessionMeta> {
    const src = this.requireSession(sessionId)
    const project = this.store.getProject(src.projectId)
    if (!project) throw new Error('Project not found')

    let cwd = src.cwd
    let baseRef = src.baseRef
    if (src.environment === 'worktree') {
      const wt = await GitService.createWorktree(
        project.path,
        worktreeNameFor(src.title + '-fork'),
        this.worktreeDir(project.id),
        this.branchPrefix(project.id)
      )
      cwd = wt.worktreePath
      baseRef = wt.baseBranch
    }
    const dup = this.store.createSession({
      projectId: src.projectId,
      backend: src.backend,
      title: `${src.title} (fork)`,
      model: src.model ?? undefined,
      cwd,
      environment: src.environment,
      baseRef,
      permissionMode: src.permissionMode
    })
    // transcript continuity in the UI
    this.store.copyEvents(sessionId, dup.id)
    if (src.environment === 'worktree') {
      // background, same as createSession — never parks the fork on npm install
      void this.runSetup(dup.id, cwd, project.path, project.id)
    }

    if (src.backendSessionId) {
      const adapter = this.spawnAdapter(
        { ...dup, backendSessionId: src.backendSessionId },
        src.backendSessionId,
        true
      )
      this.adapters.set(dup.id, adapter)
    }
    this.updateSession(dup.id, { status: 'idle' })
    return this.store.getSession(dup.id)!
  }

  /**
   * Cross-agent handoff: start a FRESH session on a DIFFERENT backend, in the
   * SAME working directory, seeded with this session's conversation reconstructed
   * as text (Angel: hit my Claude limit, keep going on Codex). Not a native resume
   * — backend session ids don't cross agents — so the new agent reads a summary of
   * the history (tool calls as prose) rather than resuming live tool state. Reuses
   * the source cwd so any uncommitted work carries over (no new worktree).
   */
  async forkToBackend(
    sessionId: string,
    backend: BackendId,
    model?: string
  ): Promise<SessionMeta> {
    const src = this.store.getSession(sessionId)
    if (!src) throw new Error(`Unknown session: ${sessionId}`)
    const events = this.store.getEvents(sessionId).map((e) => e.event)
    const seed = buildHandoffSeed(events, {
      sourceBackend: src.backend,
      // Cursor passes the prompt as an argv (ARG_MAX) → smaller budget
      maxChars: backend === 'cursor' ? 16_000 : 48_000
    })
    const session = this.store.createSession({
      projectId: src.projectId,
      backend,
      title: `${src.title} → ${backendLabel(backend)}`,
      model,
      cwd: src.cwd,
      environment: src.environment,
      baseRef: src.baseRef,
      permissionMode: src.permissionMode,
      remoteHostId: src.remoteHostId ?? undefined
    })
    const adapter = this.spawnAdapter(session)
    this.adapters.set(session.id, adapter)
    adapter.prompt(seed)
    this.updateSession(session.id, { status: 'running' })
    return this.store.getSession(session.id)!
  }

  /** Switch model mid-session (Cursor's in-composer model picker). */
  setModel(sessionId: string, model: string): void {
    this.updateSession(sessionId, { model })
    this.adapters.get(sessionId)?.setModel?.(model)
  }

  /**
   * Set the Claude reasoning-effort level (low|medium|high|xhigh|max, '' = auto).
   * There's no live control request for it, so we dispose the adapter — the next
   * prompt re-spawns claude with --effort applied.
   */
  setEffort(sessionId: string, effort: string): void {
    this.settings.setSetting(`effort:${sessionId}`, effort)
    const adapter = this.adapters.get(sessionId)
    if (adapter) {
      adapter.dispose()
      this.adapters.delete(sessionId)
    }
  }

  /**
   * Switch a session's permission mode. The mode is baked into the CLI process
   * at spawn (--permission-mode / codex approvalPolicy), so there's no live
   * control for it: we update the session row, then dispose the idle adapter so
   * the next prompt re-spawns with the new mode. If a turn is in flight we leave
   * the adapter alone — handleAgentEvent's turn-complete branch disposes it once
   * the mode it was spawned with no longer matches the session's.
   */
  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    const session = this.store.getSession(sessionId)
    if (!session || session.permissionMode === mode) return
    this.updateSession(sessionId, { permissionMode: mode })
    const running = session.status === 'running' || session.status === 'starting'
    if (running) return
    const adapter = this.adapters.get(sessionId)
    if (adapter) {
      adapter.dispose()
      this.adapters.delete(sessionId)
      this.spawnedPermissionMode.delete(sessionId)
    }
  }

  /**
   * Edit an already-sent user message and resend — HONESTLY per backend, never
   * faking a rewind a backend can't do (see rewindStrategy.ts):
   *   - claude → true CC fork (`--resume-session-at`): truncate + resend.
   *   - codex  → true in-place rollback (app-server `thread/rollback`), with an
   *              honest append fallback if the backend refuses to truncate.
   *   - cursor → honest append: no fork/truncate primitive exists, so the edited
   *              text is resent as a NEW turn; the earlier messages all stay.
   */
  async rewind(
    sessionId: string,
    originalText: string,
    occurrenceFromEnd: number,
    newText: string
  ): Promise<void> {
    const session = this.requireSession(sessionId)
    const strategy = rewindStrategyFor(session.backend)

    // Editing while a turn is running always STOPS the turn first (Angel's
    // call, Jul 15) — Claude's fork path effectively did this by disposing the
    // adapter, but Codex/Cursor fired the edit concurrently, racing two turns.
    if (session.status === 'running') {
      this.interrupt(sessionId)
      await this.waitForTurnEnd(sessionId, 5_000)
    }

    // locate the edited message in hang4r's own transcript (all backends share
    // this) and keep its image attachments to re-send with the edit
    const events = this.store.getEvents(sessionId)
    const matches = events.filter(
      (e) => e.event.kind === 'user-text' && e.event.text.trim() === originalText.trim()
    )
    const target = matches[matches.length - 1 - occurrenceFromEnd]
    const images =
      target && target.event.kind === 'user-text' && target.event.images?.length
        ? target.event.images
        : undefined

    if (strategy === 'fork') {
      return this.rewindClaudeFork(session, originalText, occurrenceFromEnd, newText, target, images)
    }

    if (strategy === 'rollback' && target) {
      // Codex: attempt a REAL in-place rollback on the live app-server. Ensure
      // the adapter is alive first (a re-spawn resumes the thread, loading its
      // history so rollback has something to truncate).
      const userSeqs = events.filter((e) => e.event.kind === 'user-text').map((e) => e.seq)
      const turns = turnsToRewind(userSeqs, target.seq)
      const adapter = await this.ensureAdapter(sessionId)
      const truncated = (await adapter.rewindTurns?.(turns)) ?? false
      if (truncated) {
        this.store.deleteEventsFrom(sessionId, target.seq)
        const agentText = this.writeImageAttachments(session, newText, images)
        adapter.prompt(agentText, images, agentText !== newText ? { displayText: newText } : undefined)
        this.updateSession(sessionId, { status: 'running', lastError: null })
        return
      }
      // the backend refused (deprecated/removed rollback, or replay failure) —
      // fall through to the honest append rather than dropping the edit
    }

    // Cursor, or Codex when the backend couldn't truncate: HONEST append. Leave
    // the transcript intact and resend the edited text as a fresh turn. Cursor's
    // headless mode can't ingest images, so don't claim to re-send them there.
    const resendImages = session.backend === 'cursor' ? undefined : images
    await this.prompt(sessionId, newText, resendImages)
  }

  /**
   * Claude's CC-native rewind: fork the backend session truncated at the edited
   * message's parent (`--resume-session-at`), drop hang4r's events from that
   * message onward, and send the edited text as the next turn.
   */
  private async rewindClaudeFork(
    session: SessionMeta,
    originalText: string,
    occurrenceFromEnd: number,
    newText: string,
    target: SessionEvent | undefined,
    images: PromptImage[] | undefined
  ): Promise<void> {
    if (!session.backendSessionId)
      throw new Error('No backend session to rewind — send at least one message first.')

    // SSH sessions: the conversation jsonl lives on the REMOTE host — fetch it
    // over the Exec seam and parse the anchor from content; local reads a file.
    let anchor: { parentUuid: string | null } | null
    if (session.environment === 'ssh') {
      const host = this.remoteHost(session.remoteHostId)?.host
      if (!host) throw new Error('This SSH session has no configured host anymore.')
      const { stdout } = await sshExec(host).run(
        'sh',
        ['-c', `cat ~/.claude/projects/*/${session.backendSessionId}.jsonl 2>/dev/null`],
        { timeout: 30_000 }
      )
      anchor = parseRewindAnchor(stdout, originalText, occurrenceFromEnd)
    } else {
      anchor = ClaudeImport.findRewindAnchor(
        session.backendSessionId,
        originalText,
        occurrenceFromEnd
      )
    }
    if (!anchor)
      throw new Error("Couldn't locate that message in the Claude session history to rewind.")

    if (target) this.store.deleteEventsFrom(session.id, target.seq)

    // replace the live adapter with a fork truncated at the anchor. A null
    // parentUuid means the edited message was the very first — start fresh.
    this.adapters.get(session.id)?.dispose()
    this.adapters.delete(session.id)
    await this.ensureWorkdir(session.id, true) // editing+re-running = continue here → rebuild if dropped
    const adapter = anchor.parentUuid
      ? this.spawnAdapter(session, session.backendSessionId, true, anchor.parentUuid)
      : this.spawnAdapter(session)
    this.adapters.set(session.id, adapter)
    const agentText = this.writeImageAttachments(session, newText, images)
    adapter.prompt(agentText, images, agentText !== newText ? { displayText: newText } : undefined)
    this.updateSession(session.id, { status: 'running', lastError: null })
  }

  /** Return the session's live adapter, re-spawning it (resumed) if none is up. */
  private async ensureAdapter(sessionId: string): Promise<AgentAdapter> {
    let adapter = this.adapters.get(sessionId)
    if (!adapter) {
      await this.ensureWorkdir(sessionId, true) // spawning to run = continue here → rebuild if dropped
      const session = this.requireSession(sessionId)
      adapter = this.spawnAdapter(session, session.backendSessionId ?? undefined)
      this.adapters.set(sessionId, adapter)
    }
    return adapter
  }

  /** Re-send the session's last user message as a fresh turn. */
  retry(sessionId: string): void {
    const events = this.store.getEvents(sessionId)
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i].event
      if (ev.kind === 'user-text') {
        void this.prompt(sessionId, ev.text)
        return
      }
    }
    throw new Error('No previous user message to retry.')
  }

  async archive(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    this.adapters.get(sessionId)?.dispose()
    this.adapters.delete(sessionId)
    // the UI must see the archive INSTANTLY — deleting a worktree with a full
    // node_modules takes many seconds, and awaiting it here froze the app with
    // a ghost session still listed/selected (Angel hit this live). Mark first,
    // clean the tree in the background (removeWorktree already tolerates
    // "already gone", so a re-archive or a crashed cleanup is harmless).
    this.updateSession(sessionId, { status: 'archived' })
    if (session?.environment === 'worktree') {
      const project = this.store.getProject(session.projectId)
      if (project) void GitService.removeWorktree(project.path, session.cwd)
    }
    if (session?.environment === 'ssh') {
      const host = this.remoteHost(session.remoteHostId)?.host
      // tear down the multiplexing master unless another live ssh session uses it
      if (host) {
        const stillUsed = this.store
          .listSessions()
          .some(
            (s) =>
              s.id !== sessionId &&
              s.environment === 'ssh' &&
              s.status !== 'archived' &&
              this.remoteHost(s.remoteHostId)?.host === host
          )
        if (!stillUsed) void closeMaster(host)
      }
      closeTunnels(sessionId)
    }
  }

  /** Permanent delete (vs archive, which keeps the conversation): same adapter +
   *  environment teardown as archive, then drop the session from the DB entirely.
   *  For a wedged session, archive isn't enough — the transcript (and whatever
   *  wedged it) stays and can be restored. */
  async deleteSession(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    this.adapters.get(sessionId)?.dispose()
    this.adapters.delete(sessionId)
    this.spawnedPermissionMode.delete(sessionId)
    if (session?.environment === 'worktree') {
      const project = this.store.getProject(session.projectId)
      if (project) void GitService.removeWorktree(project.path, session.cwd)
    }
    if (session?.environment === 'ssh') {
      const host = this.remoteHost(session.remoteHostId)?.host
      if (host) {
        const stillUsed = this.store
          .listSessions()
          .some(
            (s) =>
              s.id !== sessionId &&
              s.environment === 'ssh' &&
              s.status !== 'archived' &&
              this.remoteHost(s.remoteHostId)?.host === host
          )
        if (!stillUsed) void closeMaster(host)
      }
      closeTunnels(sessionId)
    }
    this.store.deleteSession(sessionId)
  }

  disposeAll(): void {
    for (const adapter of this.adapters.values()) adapter.dispose()
    this.adapters.clear()
    this.spawnedPermissionMode.clear()
  }

  /** The session's REAL current branch (worktree HEAD) — the UI must never fabricate one. */
  async currentBranch(sessionId: string): Promise<string | null> {
    const session = this.store.getSession(sessionId)
    if (!session || this.cwdMissing(session)) return null
    try {
      return await GitService.currentBranch(session.cwd, this.execFor(session))
    } catch {
      return null // not a repo / detached — the tile falls back to baseRef
    }
  }

  /* ---------- review / diff ---------- */

  /**
   * A worktree session's directory can go missing (cleaned up, app moved).
   * Recreate it on demand so file/diff/terminal panes keep working. Returns
   * the current (possibly recreated) working directory.
   */
  /** resolve a configured SSH host (Settings → Remote) by id */
  remoteHost(id: string | null | undefined): { id: string; label: string; host: string; dir: string } | null {
    if (!id) return null
    try {
      const hosts = JSON.parse(this.settings.getSetting('sshHosts') ?? '[]') as {
        id: string
        label: string
        host: string
        dir: string
      }[]
      return hosts.find((h) => h.id === id) ?? null
    } catch {
      return null
    }
  }

  async ensureWorkdir(sessionId: string, recreate = false): Promise<string> {
    const session = this.requireSession(sessionId)
    if (session.environment === 'ssh') return session.cwd // remote path — not ours to create
    if (existsSync(session.cwd)) return session.cwd
    if (session.environment !== 'worktree') return session.cwd
    // The worktree is gone. Do NOT silently resurrect it on PASSIVE access (file
    // tree, terminal, git, focus) — the user may have cleaned it (via "Drop
    // worktree" or their own tooling) and just wants to READ the conversation
    // (Angel). Those panels degrade gracefully on a missing dir. Rebuild ONLY on
    // an explicit request: a prompt to continue, or the Recreate action.
    if (!recreate) {
      if (!session.worktreeDropped) {
        const s = this.store.updateSession(sessionId, { worktreeDropped: true })
        if (s) this.broadcast.sessionUpdated(s)
      }
      return session.cwd
    }
    const project = this.store.getProject(session.projectId)
    if (!project || !(await GitService.isRepo(project.path))) return session.cwd
    // Prefer RE-ATTACHING the original branch at the original path — Drop/remove
    // left the branch behind, so this restores the session's commits instead of
    // branching fresh from HEAD (which would also dodge the leftover branch by
    // suffixing -2). Fall back to a fresh worktree only if the branch is gone.
    const origBranch = `${this.branchPrefix(project.id)}${basename(session.cwd)}`
    const reattached = await GitService.reattachWorktree(
      project.path,
      session.cwd,
      origBranch
    ).catch(() => false)
    if (reattached) {
      this.store.updateSession(sessionId, { worktreeDropped: false })
      void this.runSetup(sessionId, session.cwd, project.path, project.id)
      const back = this.store.getSession(sessionId)
      if (back) this.broadcast.sessionUpdated(back)
      return session.cwd
    }
    const wt = await GitService.createWorktree(
      project.path,
      worktreeNameFor(session.title),
      this.worktreeDir(project.id),
      this.branchPrefix(project.id)
    )
    this.store.setSessionWorkdir(sessionId, wt.worktreePath, wt.baseBranch)
    this.store.updateSession(sessionId, { worktreeDropped: false }) // rebuilt → no longer dropped
    // background: a prompt that triggered this recreate must not hang for the
    // length of an npm install (Angel hit exactly that wait)
    void this.runSetup(sessionId, wt.worktreePath, project.path, project.id)
    const updated = this.store.getSession(sessionId)
    if (updated) this.broadcast.sessionUpdated(updated)
    return wt.worktreePath
  }

  /**
   * Remove a worktree session's worktree from disk but keep the session LIVE and
   * its conversation intact/searchable (unlike archive, which hides it). Marks it
   * dropped so ensureWorkdir won't rebuild it on open (Angel: manual cleanup kept
   * getting resurrected). Recreate re-provisions it when you want to continue.
   */
  async dropWorktree(sessionId: string): Promise<SessionMeta | undefined> {
    const session = this.store.getSession(sessionId)
    if (!session) return undefined
    if (session.environment !== 'worktree') return session // no-op for local/ssh
    this.adapters.get(sessionId)?.dispose() // release the dir before removing it
    this.adapters.delete(sessionId)
    const project = this.store.getProject(session.projectId)
    if (project) void GitService.removeWorktree(project.path, session.cwd) // bg (tolerates already-gone)
    const updated = this.store.updateSession(sessionId, { worktreeDropped: true, status: 'idle' })
    if (updated) this.broadcast.sessionUpdated(updated)
    return updated
  }

  /** rebuild a dropped worktree (+ re-run setup) so the user can continue */
  async recreateWorktree(sessionId: string): Promise<SessionMeta | undefined> {
    await this.ensureWorkdir(sessionId, true)
    const updated = this.store.getSession(sessionId)
    if (updated) this.broadcast.sessionUpdated(updated)
    return updated
  }

  /**
   * Worktree container dir for a workspace: per-project setting wins, then the
   * global default, then the built-in `.hang4r-worktrees`. Each repo can differ.
   */
  private worktreeDir(projectId: string): string {
    return (
      this.settings.getSetting(`worktreeDir:${projectId}`)?.trim() ||
      this.settings.getSetting('worktreeDir')?.trim() ||
      DEFAULT_WORKTREE_DIR
    )
  }

  /**
   * Branch prefix for session worktrees (workspace over app). Default NONE:
   * the worktree's branch is exactly the name the user gave the session —
   * prefixing was hardcoded `hang4r/` once, and since git tools identify a
   * worktree by its branch, every worktree looked hang4r-owned. Opt back in
   * per-repo with the `worktreeBranchPrefix` setting (e.g. "agents/").
   */
  private branchPrefix(projectId: string): string {
    return this.settings.resolve('worktreeBranchPrefix', projectId)?.trim() ?? ''
  }

  /** Does this workspace have a setup script configured (workspace over app)? */
  private hasSetupScript(projectId: string): boolean {
    return !!this.settings.resolve('setupScript', projectId)?.trim()
  }

  /**
   * Run the workspace's setup script once in a freshly-created worktree (install
   * deps, symlink, etc.). Per-project script wins over the global one (via
   * resolve(), so an empty workspace value falls through instead of shadowing).
   * Runs through the user's LOGIN shell (`shell -lc`) — a Finder-launched GUI
   * app only has /usr/bin:/bin on PATH, so a plain /bin/sh spawn can't find
   * npm/nvm/homebrew tools; the agent CLIs and the terminal already resolve
   * this way. Outcome lands in the transcript as durable setup-note events
   * (lastError alone is wiped by the next turn). Best effort: failures never
   * block the session — ROOT_WORKTREE_PATH points at the main repo.
   */
  private async runSetup(
    sessionId: string,
    worktreePath: string,
    repoDir: string,
    projectId: string
  ): Promise<boolean> {
    const script = this.settings.resolve('setupScript', projectId)?.trim()
    if (!script) return true
    const shell = resolveShell(this.settings.resolve('terminalShell', projectId) ?? undefined)
    this.handleAgentEvent(sessionId, {
      kind: 'setup-note',
      text: `Running setup script: ${script}`
    })
    const started = Date.now()
    const failure = await new Promise<string | null>((resolve) => {
      let out = ''
      const child = spawn(shell, ['-lc', script], {
        cwd: worktreePath,
        // setup scripts get the hang4r browser CLI env too (worktrees are local)
        env: { ...process.env, ROOT_WORKTREE_PATH: repoDir, ...this.browserEnv?.(sessionId) }
      })
      child.stdout?.on('data', (d) => (out += d.toString()))
      child.stderr?.on('data', (d) => (out += d.toString()))
      child.on('error', (e) => resolve(`Setup script failed to start (${shell}): ${String(e)}`))
      child.on('exit', (code) =>
        resolve(code ? `Setup script exited ${code}: ${out.slice(-400)}` : null)
      )
    })
    if (failure) {
      this.handleAgentEvent(sessionId, { kind: 'setup-note', text: failure, isError: true })
      this.updateSession(sessionId, { lastError: failure })
      return false
    } else {
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      this.handleAgentEvent(sessionId, {
        kind: 'setup-note',
        text: `Setup script finished in ${secs}s`
      })
    }
    return true
  }

  /** The session's setup-script outcome, if one was started at creation —
   *  null when there was nothing to run. Dev-process auto-start awaits this. */
  setupResult(sessionId: string): Promise<boolean> | null {
    return this.setupRuns.get(sessionId) ?? null
  }

  /** how a session's git/file commands run: local subprocess, or over ssh */
  execFor(session: SessionMeta): Exec {
    const host =
      session.environment === 'ssh' ? this.remoteHost(session.remoteHostId)?.host : undefined
    return host ? sshExec(host) : LocalExec
  }

  private isSsh(session: SessionMeta): boolean {
    return session.environment === 'ssh'
  }

  /** cwd sanity: local sessions need the dir on disk; remote cwd is opaque */
  private cwdMissing(session: SessionMeta): boolean {
    return !this.isSsh(session) && !existsSync(session.cwd)
  }

  async changedFiles(sessionId: string): Promise<ChangedFile[]> {
    const session = this.requireSession(sessionId)
    // ssh sessions diff against HEAD (no worktree base branch)
    const baseRef = session.baseRef || (this.isSsh(session) ? 'HEAD' : '')
    if (!baseRef) return []
    if (this.cwdMissing(session)) return []
    return GitService.changedFiles(session.cwd, baseRef, this.execFor(session)).catch(() => [])
  }

  async gitStatus(sessionId: string): Promise<Record<string, { badge: string; staged: boolean }>> {
    const session = this.requireSession(sessionId)
    if (this.cwdMissing(session)) return {}
    if (!(await GitService.isRepo(session.cwd, this.execFor(session)))) return {}
    return GitService.statusMap(session.cwd, this.execFor(session))
  }

  async gitLineStatus(
    sessionId: string,
    path: string
  ): Promise<{ added: number[]; modified: number[]; deleted: number[] }> {
    const session = this.requireSession(sessionId)
    if (this.cwdMissing(session)) return { added: [], modified: [], deleted: [] }
    return GitService.lineStatus(session.cwd, path, this.execFor(session))
  }

  async gitStage(sessionId: string, path: string): Promise<void> {
    const s = this.requireSession(sessionId)
    await GitService.stage(s.cwd, path, this.execFor(s))
  }
  async gitUnstage(sessionId: string, path: string): Promise<void> {
    const s = this.requireSession(sessionId)
    await GitService.unstage(s.cwd, path, this.execFor(s))
  }
  async gitDiscard(sessionId: string, path: string): Promise<void> {
    const s = this.requireSession(sessionId)
    await GitService.discard(s.cwd, path, this.execFor(s))
  }

  async fileDiff(sessionId: string, path: string, ignoreWs = false): Promise<string> {
    const session = this.requireSession(sessionId)
    const baseRef = session.baseRef || (this.isSsh(session) ? 'HEAD' : '')
    if (!baseRef) return ''
    return GitService.fileDiff(session.cwd, baseRef, path, ignoreWs, this.execFor(session))
  }

  /** The review-scope base ref: the session's base, falling back to HEAD. */
  private scopeBaseRef(session: SessionMeta): string {
    return session.baseRef || 'HEAD'
  }

  async scopedFiles(sessionId: string, scope: DiffScope): Promise<ScopedFiles> {
    const session = this.requireSession(sessionId)
    if (this.cwdMissing(session)) return { files: [], adds: 0, dels: 0 }
    return GitService.scopedFiles(
      session.cwd,
      scope,
      this.scopeBaseRef(session),
      this.execFor(session)
    ).catch(() => ({ files: [], adds: 0, dels: 0 }))
  }

  async scopedDiff(
    sessionId: string,
    scope: DiffScope,
    path: string,
    ignoreWs = false
  ): Promise<string> {
    const session = this.requireSession(sessionId)
    if (this.cwdMissing(session)) return ''
    return GitService.scopedDiff(
      session.cwd,
      scope,
      this.scopeBaseRef(session),
      path,
      ignoreWs,
      this.execFor(session)
    ).catch(() => '')
  }

  async scopeSummary(sessionId: string): Promise<ScopeSummary[]> {
    const session = this.requireSession(sessionId)
    if (this.cwdMissing(session)) return []
    if (!session.baseRef && !this.isSsh(session)) return [] // non-repo local session
    return GitService.scopeSummary(
      session.cwd,
      this.scopeBaseRef(session),
      this.execFor(session)
    ).catch(() => [])
  }

  /** Revert one hunk in the working tree (discard those lines). */
  async revertHunk(sessionId: string, _path: string, patch: string): Promise<void> {
    const s = this.requireSession(sessionId)
    await GitService.applyPatch(s.cwd, patch, { reverse: true }, this.execFor(s))
  }

  /** Stage one hunk into the index. */
  async stageHunk(sessionId: string, _path: string, patch: string): Promise<void> {
    const s = this.requireSession(sessionId)
    await GitService.applyPatch(s.cwd, patch, { cached: true }, this.execFor(s))
  }

  /** The unified-diff patch for the hunk containing a line (inline peek). */
  async hunkAtLine(sessionId: string, path: string, line: number): Promise<string | null> {
    const s = this.requireSession(sessionId)
    return GitService.hunkPatchAtLine(s.cwd, path, line, this.execFor(s))
  }

  /** Stage the hunk containing a line (inline editor gutter). */
  async stageHunkAtLine(sessionId: string, path: string, line: number): Promise<void> {
    const s = this.requireSession(sessionId)
    const via = this.execFor(s)
    const patch = await GitService.hunkPatchAtLine(s.cwd, path, line, via)
    if (patch) await GitService.applyPatch(s.cwd, patch, { cached: true }, via)
    else await GitService.stage(s.cwd, path, via) // untracked → stage the whole file
  }

  /** Revert (discard) the hunk containing a line in the working tree. */
  async revertHunkAtLine(sessionId: string, path: string, line: number): Promise<void> {
    const s = this.requireSession(sessionId)
    const via = this.execFor(s)
    const patch = await GitService.hunkPatchAtLine(s.cwd, path, line, via)
    if (patch) await GitService.applyPatch(s.cwd, patch, { reverse: true }, via)
    else await GitService.discard(s.cwd, path, via) // untracked → remove the file
  }

  /**
   * The differentiator: serialize inline review comments into a single
   * structured follow-up prompt and send it as the next turn.
   */
  submitReview(sessionId: string, comments: ReviewComment[]): void {
    if (comments.length === 0) return
    const byFile = new Map<string, ReviewComment[]>()
    for (const c of comments) {
      const list = byFile.get(c.path) ?? []
      list.push(c)
      byFile.set(c.path, list)
    }
    let prompt =
      'I reviewed your changes and left inline comments. Please address each one, ' +
      'then briefly summarize what you changed:\n'
    for (const [path, list] of byFile) {
      prompt += `\n${path}:\n`
      for (const c of list.sort((a, b) => a.line - b.line)) {
        // file-level comments (anchor 'file', line 0) aren't about a line
        const tag = c.anchor === 'file' || c.line === 0 ? 'file' : `L${c.line}`
        prompt += `  - ${tag}: ${c.body}\n`
      }
    }
    void this.prompt(sessionId, prompt)
  }

  /* ---------- review actions (Cursor's stage/commit/PR surface) ---------- */

  async commitSession(sessionId: string, message: string): Promise<string | null> {
    const session = this.requireSession(sessionId)
    return GitService.commitWithMessage(
      session.cwd,
      message || `hang4r: ${session.title}`,
      this.execFor(session)
    )
  }

  /** Commit everything, then push the current branch to origin. */
  async commitPushSession(sessionId: string, message: string): Promise<string | null> {
    const session = this.requireSession(sessionId)
    const via = this.execFor(session)
    const sha = await GitService.commitWithMessage(
      session.cwd,
      message || `hang4r: ${session.title}`,
      via
    )
    const branch = await GitService.currentBranch(session.cwd, via)
    await GitService.push(session.cwd, branch, via)
    return sha
  }

  /** Create a new branch, commit everything onto it, then push. */
  async branchCommitPushSession(
    sessionId: string,
    branch: string,
    message: string
  ): Promise<string | null> {
    const session = this.requireSession(sessionId)
    const via = this.execFor(session)
    await GitService.createBranch(session.cwd, branch, via)
    const sha = await GitService.commitWithMessage(
      session.cwd,
      message || `hang4r: ${session.title}`,
      via
    )
    await GitService.push(session.cwd, branch, via)
    return sha
  }

  async mergeSessionToBase(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.environment !== 'worktree') {
      throw new Error('Merge to base only applies to worktree sessions.')
    }
    const project = this.store.getProject(session.projectId)
    if (!project) throw new Error('Project not found')
    // commit any pending changes first so nothing is lost
    await GitService.commitAll(session.cwd, `hang4r: ${session.title} (final)`)
    const branch = await GitService.currentBranch(session.cwd)
    await GitService.mergeToBase(project.path, branch, `${session.title} (hang4r session)`)
  }

  async createSessionPr(sessionId: string): Promise<string> {
    const session = this.requireSession(sessionId)
    const via = this.execFor(session)
    const hostLabel = this.isSsh(session) ? this.remoteHost(session.remoteHostId)?.host : undefined
    await GitService.commitAll(session.cwd, `hang4r: ${session.title} (final)`, via)
    const branch = await GitService.currentBranch(session.cwd, via)
    return GitService.createPr(
      session.cwd,
      branch,
      session.title,
      'Created with hang4r — agent session output.',
      via,
      hostLabel
    )
  }

  /* ---------- internals ---------- */

  private spawnAdapter(
    session: SessionMeta,
    resumeSessionId?: string,
    fork = false,
    resumeAt?: string
  ): AgentAdapter {
    // record the mode this process is being baked with, so a later mid-turn
    // switch can detect divergence and respawn on the next prompt
    this.spawnedPermissionMode.set(session.id, session.permissionMode)
    if (FAKE_AGENT) {
      const fake = new FakeAdapter()
      fake.onEvent((ev) => this.handleAgentEvent(session.id, ev))
      fake.start({
        binaryPath: 'fake',
        cwd: session.cwd,
        model: session.model ?? undefined,
        permissionMode: session.permissionMode,
        resumeSessionId,
        fork,
        resumeAt
      })
      return fake
    }
    const adapter =
      session.backend === 'codex'
        ? this.makeCodexAdapter(session)
        : session.backend === 'cursor'
          ? this.makeCursorAdapter(session)
          : this.makeClaudeAdapter(session)
    adapter.onEvent((ev) => this.handleAgentEvent(session.id, ev))
    const sshHost =
      session.environment === 'ssh' ? this.remoteHost(session.remoteHostId)?.host : undefined
    adapter.start({
      // remote sessions use the REMOTE host's claude (login-shell PATH)
      binaryPath: sshHost
        ? 'claude'
        : adapter.backend === 'claude'
          ? this.claudeBinary()
          : adapter.backend === 'cursor'
            ? this.cursorBinary()
            : this.codexBinary(),
      cwd: session.cwd,
      model: session.model ?? undefined,
      effort: this.settings.getSetting(`effort:${session.id}`)?.trim() || undefined,
      permissionMode: session.permissionMode,
      resumeSessionId,
      fork,
      resumeAt,
      sshHost,
      // ssh runs the CLI on the remote host — no reach to the local control socket
      env: sshHost ? undefined : this.browserEnv?.(session.id)
    })
    return adapter
  }

  private makeClaudeAdapter(_session: SessionMeta): AgentAdapter {
    return new ClaudeAdapter()
  }

  private makeCodexAdapter(_session: SessionMeta): AgentAdapter {
    return new CodexAdapter()
  }

  private makeCursorAdapter(_session: SessionMeta): AgentAdapter {
    return new CursorAdapter()
  }

  private claudeBinary(): string {
    const override = this.settings.getSetting('claudeBinaryPath')
    const binaryPath = findBinary('claude', override)
    if (!binaryPath) {
      throw new Error(
        'Claude Code CLI not found. Install it and log in, or set its path in Settings.'
      )
    }
    return binaryPath
  }

  private codexBinary(): string {
    const override = this.settings.getSetting('codexBinaryPath')
    const binaryPath = findBinary('codex', override)
    if (!binaryPath) {
      throw new Error(
        'Codex CLI not found. Install it (npm i -g @openai/codex) and log in, or set its path in Settings.'
      )
    }
    return binaryPath
  }

  private cursorBinary(): string {
    const override = this.settings.getSetting('cursorBinaryPath')
    const binaryPath = findBinary('cursor-agent', override)
    if (!binaryPath) {
      throw new Error(
        'Cursor CLI not found. Install cursor-agent and log in (cursor-agent login), or set its path in Settings.'
      )
    }
    return binaryPath
  }

  /**
   * Relabel the CLI's OPAQUE `error_during_execution` (the classifier's generic
   * "The CLI errored" — empty/unhelpful stderr) as an interrupted turn when
   * hang4r's OWN signal proves it: the session's jsonl tail is POISONED (an
   * assistant `tool_use` with no matching `tool_result` — the exact residue of a
   * turn killed mid-command by a session restart or an external "⇄ interactive
   * CLI" driver). This is the MOST COMMON error_during_execution and the heal-
   * before-resume path already recovers it on the next prompt, so the user should
   * see "Interrupted mid-command — recovered on next turn" instead of a scary
   * catch-all. DISPLAY ONLY — purely additive:
   *   - it fires only on the generic label, so the classifier's SPECIFIC labels
   *     (Overloaded 529, Rate limited, Context length) still win when present, and
   *   - it never touches the user-initiated 'interrupted' sentinel (that string is
   *     set by the adapter and keys recovery), nor heal/recovery/auto-continue.
   * `errorDetail` (the raw error_during_execution text) is preserved for the
   * renderer's expandable panel.
   */
  private relabelOpaqueInterrupt(
    sessionId: string,
    ev: Extract<AgentEvent, { kind: 'turn-complete' }>
  ): void {
    // only the generic catch-all — the specific classifier labels and the
    // user-stop 'interrupted' sentinel are NOT this string, so they pass through
    if (ev.errorMessage !== 'The CLI errored') return
    const session = this.store.getSession(sessionId)
    if (!session || session.backend !== 'claude' || !session.backendSessionId) return
    if (!ClaudeImport.tailIsPoisoned(session.backendSessionId)) return
    ev.errorMessage = 'Interrupted mid-command — recovered on next turn'
  }

  private handleAgentEvent(sessionId: string, ev: AgentEvent): void {
    // Streaming token fragments (block-delta) are TRANSIENT: broadcast them so the
    // renderer streams text LIVE, but do NOT persist. block-final carries the whole
    // block's text, so the reload/replay is identical — while persisting every token
    // had grown the transcript DB past 200k rows (≈73% deltas) and its synchronous
    // per-token SQLite write saturated the main event loop, so switching sessions
    // froze until the running turn finished (Angel). seq:0 flags it transient; the
    // renderer applies it un-gated (it never advances lastSeq).
    if (ev.kind === 'block-delta') {
      this.broadcast.agentEvent({ sessionId, seq: 0, ts: Date.now(), event: ev })
      return
    }
    // Relabel the CLI's OPAQUE error_during_execution as an interrupted turn when
    // hang4r's OWN signals prove it — BEFORE persist/broadcast so the transcript
    // and the live renderer both carry the reassuring label, not the scary
    // catch-all. Display only (see relabelOpaqueInterrupt).
    if (ev.kind === 'turn-complete' && ev.isError) this.relabelOpaqueInterrupt(sessionId, ev)
    const persisted = this.store.appendEvent(sessionId, ev)
    this.broadcast.agentEvent(persisted)

    if (ev.kind === 'init') {
      // Keep the user's SELECTED model choice (e.g. 'fable') — do NOT overwrite it
      // with the CLI's resolved id (e.g. 'claude-fable-5-…'), which wouldn't match
      // the picker's option value and made it snap back to 'Default'. The resolved
      // model is still captured in sessionInit for the Env tab.
      this.updateSession(sessionId, { backendSessionId: ev.backendSessionId })
    } else if (ev.kind === 'turn-complete') {
      const session = this.store.getSession(sessionId)
      // a user-initiated interrupt is NOT an error: the cursor adapter (and any
      // synthesized kill path) reports isError with errorMessage 'interrupted' —
      // painting that red (status dot, sidebar error badge, error notification)
      // conflated "you stopped it" with "it failed" (flagged twice by QA agents)
      const interrupted = ev.isError && ev.errorMessage === 'interrupted'
      // remember a user-initiated stop so auto-continue doesn't drive over you;
      // any clean turn clears it (you let it run again)
      if (interrupted) this.userInterrupted.add(sessionId)
      else if (!ev.isError) this.userInterrupted.delete(sessionId)
      this.updateSession(sessionId, {
        status: ev.isError && !interrupted ? 'error' : 'idle',
        lastError: ev.isError && !interrupted ? (ev.errorMessage ?? 'unknown error') : null,
        // total_cost_usd is the session's CUMULATIVE cost — set it, don't add
        // (adding each turn triangular-summed into absurd values, e.g. $105).
        totalCostUsd: ev.costUsd ?? session?.totalCostUsd ?? 0
      })
      if (!ev.isError && session?.environment === 'worktree') {
        void this.commitCheckpoint(session)
      }
      // An aborted turn (e.g. Claude's error_during_execution) can leave the
      // CLI process wedged — every follow-up prompt then errors too, until a
      // full app restart (Angel hit exactly this). Drop the process so the next
      // prompt re-spawns clean via --resume, which re-reads the jsonl and
      // restores the whole conversation. A user interrupt is NOT a wedge — the
      // process is healthy, so we keep it.
      if (ev.isError && !interrupted) {
        this.adapters.get(sessionId)?.dispose()
        this.adapters.delete(sessionId)
        this.spawnedPermissionMode.delete(sessionId)
      }
      // a permission-mode change requested mid-turn only updated the DB row;
      // now that the turn is done, drop the adapter if it was spawned with a
      // stale mode so the next prompt re-spawns the CLI with the new one
      const spawnedMode = this.spawnedPermissionMode.get(sessionId)
      if (spawnedMode !== undefined && session && session.permissionMode !== spawnedMode) {
        this.adapters.get(sessionId)?.dispose()
        this.adapters.delete(sessionId)
        this.spawnedPermissionMode.delete(sessionId)
      }
      // sync watermark for external-CLI re-sync: once immediately (so a fast
      // follow-up prompt can't re-import our own turn) and once after a flush
      // delay (in case the CLI hadn't written the final lines yet)
      this.recordSyncWatermark(sessionId, 0)
      this.recordSyncWatermark(sessionId)
    } else if (ev.kind === 'exit') {
      const session = this.store.getSession(sessionId)
      if (session && session.status === 'running') {
        this.updateSession(sessionId, {
          status: 'error',
          lastError: `agent process exited unexpectedly (code ${ev.code})`
        })
      }
      this.adapters.get(sessionId)?.dispose()
      this.adapters.delete(sessionId)
      this.spawnedPermissionMode.delete(sessionId)
    }
  }

  private async commitCheckpoint(session: SessionMeta): Promise<void> {
    const n = (this.turnCounters.get(session.id) ?? 0) + 1
    this.turnCounters.set(session.id, n)
    try {
      await GitService.commitAll(session.cwd, `hang4r checkpoint: turn ${n} — ${session.title}`)
    } catch (err) {
      // checkpoint failures shouldn't break the session; surface as an event
      this.store.appendEvent(session.id, {
        kind: 'stderr',
        text: `checkpoint commit failed: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  private requireSession(sessionId: string): SessionMeta {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    return session
  }

  private updateSession(id: string, patch: Parameters<Store['updateSession']>[1]): void {
    const updated = this.store.updateSession(id, patch)
    if (updated) this.broadcast.sessionUpdated(updated)
  }
}

function deriveTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0]
  return line.length > 60 ? line.slice(0, 57) + '…' : line || 'New session'
}

/** File extension for a materialized image attachment, from its media type. */
function imageExt(mediaType: string | undefined): string {
  switch ((mediaType ?? '').toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/heic':
    case 'image/heif':
      return 'heic'
    case 'image/svg+xml':
    case 'image/svg':
      return 'svg'
    default:
      return 'png'
  }
}

/**
 * Worktree folder/branch name from a session title: the user's words, verbatim
 * where git allows (case preserved — "FEAT-D98" stays "FEAT-D98"), everything
 * else collapsed to '-'. No random hash suffix — createWorktree appends -2/-3
 * only on a real collision, so a named session gets exactly the name it asked
 * for (worktrunk-style: folder == branch == the name).
 */
function worktreeNameFor(title: string): string {
  const name = title
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/g, '')
  return name || 'session'
}
