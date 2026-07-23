import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  session,
  webContents,
  WebContentsView
} from 'electron'
import { join, resolve as pathResolve, sep as pathSep } from 'path'
import { homedir } from 'os'
import { readFileSync } from 'fs'
import { pathToFileURL } from 'url'
import type {
  DiffScope,
  NewSessionRequest,
  PermissionMode,
  PromptImage,
  QuestionAnswer,
  ReplaceRequest,
  ReviewComment,
  SearchOptions,
  SessionEvent,
  SessionMeta
} from '../shared/protocol'
import { SessionManager } from './services/sessionManager'
import { BrowserControlService } from './services/browserControlService'
import { CursorImport } from './services/cursorImport'
import { ClaudeImport } from './services/claudeImport'
import { CodexImport } from './services/codexImport'
import { CursorAgentImport } from './services/cursorAgentImport'
import { UpdateService } from './services/updateService'
import { AuthService } from './services/authService'
import { UsageService } from './services/usageService'
import { RemoteService, sshExec, openTunnel, type Exec } from './services/remoteService'
import { PtyService } from './services/ptyService'
import { FileService } from './services/fileService'
import { SearchService } from './services/searchService'
import { GitService } from './services/gitService'
import { CodexModelService } from './services/codexModelService'
import { CursorModelService } from './services/cursorModelService'
import type { Store } from './services/store'
import type { SettingsService, SettingsChangeScope } from './services/settingsService'

let ptyService: PtyService | null = null
export function getPtyService(): PtyService | null {
  return ptyService
}

let browserControl: BrowserControlService | null = null
export function getBrowserControl(): BrowserControlService | null {
  return browserControl
}

/**
 * Typed IPC surface. Renderer calls invoke() on these channels via the
 * preload bridge; live data flows renderer-ward on 'agent-event' and
 * 'session-updated'.
 */
export function registerIpc(store: Store, settings: SettingsService): SessionManager {
  // ---- completion notifications (Cursor-style): when an agent finishes a
  // turn while hang4r is in the background, raise a native notification and
  // a dock badge; clicking it focuses the session. Toggle in Settings.
  const finishedUnseen = new Set<string>()
  const updateBadge = (): void => {
    if (process.platform === 'darwin' && app.dock)
      app.dock.setBadge(finishedUnseen.size ? String(finishedUnseen.size) : '')
  }
  app.on('browser-window-focus', () => {
    finishedUnseen.clear()
    updateBadge()
  })
  const maybeNotify = (ev: SessionEvent): void => {
    // notify on finished turns AND on permission requests — a blocked agent
    // waiting for approval while hang4r is in the background is the worst
    // silent stall (Angel hit it live)
    const kind = ev.event.kind
    if (kind !== 'turn-complete' && kind !== 'permission-request' && kind !== 'question-request')
      return
    const session = store.getSession(ev.sessionId)
    if (!session || session.status === 'archived') return
    // three independently toggleable triggers (Settings → Notifications),
    // each resolved through the session's own workspace so a noisy project
    // can be muted without silencing the whole app. The permission-request
    // trigger fires at the exact moment the sidebar's "awaiting" badge would
    // turn on — a permission-request event IS what makes a session awaiting,
    // so the two can never disagree by construction.
    if (kind === 'permission-request' || kind === 'question-request') {
      if (settings.resolve('notifications.onActionRequired', session.projectId) === 'off') return
    } else if (ev.event.isError) {
      // a user-initiated interrupt is not a failure — never notify on it
      if (ev.event.errorMessage === 'interrupted') return
      if (settings.resolve('notifications.onError', session.projectId) === 'off') return
    } else {
      if (settings.resolve('notifyOnComplete', session.projectId) === 'off') return
    }
    if (!Notification.isSupported()) return
    if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) return
    const note =
      ev.event.kind === 'permission-request'
        ? new Notification({
            title: `⏸ ${session.title.slice(0, 60)}`,
            body: `Needs your approval: ${ev.event.tool} — ${ev.event.summary}`.slice(0, 140)
          })
        : ev.event.kind === 'question-request'
        ? new Notification({
            title: `⏸ ${session.title.slice(0, 60)}`,
            body: `Waiting on your answer: ${ev.event.questions[0]?.prompt ?? 'a question'}`.slice(0, 140)
          })
        : new Notification({
            title: `${ev.event.isError ? '✗' : '✓'} ${session.title.slice(0, 60)}`,
            body: ev.event.isError
              ? (ev.event.errorMessage ?? 'Agent turn failed').slice(0, 140)
              : 'Agent finished — ready for review'
          })
    note.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        win.webContents.send('focus-session', ev.sessionId)
      }
    })
    note.show()
    finishedUnseen.add(ev.sessionId)
    updateBadge()
  }

  // Agent-drivable browser control plane (the `hang4r browser` CLI). Constructed
  // before SessionManager so its per-session env (socket + token + PATH shim) can
  // be plumbed into every adapter / terminal / setup script the manager spawns.
  browserControl = new BrowserControlService(
    app.getPath('userData'),
    (sessionId, url) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('browser:ensure-tab', { sessionId, url })
      }
    },
    (sessionId, tabId, action) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('browser:hotkey', { sessionId, tabId, action })
      }
    },
    (sessionId, url) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('browser:open-url', { sessionId, url })
      }
    }
  )
  browserControl.start()
  ipcMain.handle('browser:guest-register', (_e, report) => browserControl!.registerGuests(report))

  // Docked page DevTools, IN the tab (Angel). Chromium DISALLOWS a <webview>
  // guest as a devtools host — that's why the old in-pane attempt rendered
  // empty. A WebContentsView works. We render the active tab's devtools into a
  // native WebContentsView that the renderer positions over the bottom of the
  // browser pane (a reserved slot), so it's docked in the tab like a real
  // browser and scoped to that tab's guest.
  let devtoolsView: WebContentsView | null = null
  let devtoolsGuestWcId: number | null = null
  const round = (b: { x: number; y: number; width: number; height: number }): Electron.Rectangle => ({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height))
  })
  const closeDockedDevtools = (): void => {
    if (devtoolsGuestWcId != null) {
      const g = webContents.fromId(devtoolsGuestWcId)
      if (g && !g.isDestroyed() && g.isDevToolsOpened()) g.closeDevTools()
      devtoolsGuestWcId = null
    }
    devtoolsView?.setVisible(false)
  }
  ipcMain.handle(
    'browser:devtools-dock',
    (e, args: { guestWcId: number; bounds: { x: number; y: number; width: number; height: number } }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const guest = webContents.fromId(args.guestWcId)
      if (!win || !guest || guest.isDestroyed()) return false
      if (!devtoolsView) {
        devtoolsView = new WebContentsView()
        win.contentView.addChildView(devtoolsView)
      }
      // switching tabs: detach the previous guest's devtools first
      if (devtoolsGuestWcId != null && devtoolsGuestWcId !== args.guestWcId) {
        const prev = webContents.fromId(devtoolsGuestWcId)
        if (prev && !prev.isDestroyed() && prev.isDevToolsOpened()) prev.closeDevTools()
      }
      devtoolsView.setBounds(round(args.bounds))
      devtoolsView.setVisible(true)
      guest.setDevToolsWebContents(devtoolsView.webContents)
      guest.openDevTools({ mode: 'detach' })
      devtoolsGuestWcId = args.guestWcId
      return true
    }
  )
  ipcMain.handle(
    'browser:devtools-bounds',
    (_e, args: { bounds: { x: number; y: number; width: number; height: number } }) => {
      if (devtoolsView && devtoolsGuestWcId != null) devtoolsView.setBounds(round(args.bounds))
    }
  )
  ipcMain.handle('browser:devtools-close', () => closeDockedDevtools())

  const sessions = new SessionManager(
    store,
    settings,
    {
    agentEvent(ev: SessionEvent) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('agent-event', ev)
      }
      // persist the environment snapshot so the Env panel has it after an app
      // restart (sessions are idle until the next turn — no live init event)
      if (ev.event.kind === 'init') {
        try {
          settings.setSetting(`sessionInitV1:${ev.sessionId}`, JSON.stringify(ev.event))
        } catch {
          /* non-fatal */
        }
      }
      maybeNotify(ev)
    },
    sessionUpdated(session: SessionMeta) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('session-updated', session)
      }
    }
    },
    (sessionId: string) => browserControl!.sessionEnv(sessionId)
  )

  ipcMain.handle('projects:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('projects:create', (_e, path: string) => {
    const project = store.createProject(path)
    settings.watchProject(project.id) // live-reload this workspace's settings.json
    return project
  })
  ipcMain.handle('projects:list', () => store.listProjects())
  ipcMain.handle('projects:remove', async (_e, projectId: string) => {
    // archive the project's live sessions, then forget the workspace
    for (const s of store.listSessions().filter((s) => s.projectId === projectId)) {
      await sessions.archive(s.id).catch(() => {})
    }
    store.removeProject(projectId)
  })

  ipcMain.handle('sessions:list', () => store.listSessions())
  ipcMain.handle('cursor:available', () => CursorImport.available())
  ipcMain.handle('cursor:list', (_e, roots?: string[]) => CursorImport.listSessions(roots))
  ipcMain.handle('cursor:transcript', (_e, composerId: string) =>
    CursorImport.getTranscript(composerId)
  )
  ipcMain.handle('claude:available', () => ClaudeImport.available())
  ipcMain.handle('claude:list', (_e, roots?: string[], offset?: number, limit?: number) =>
    ClaudeImport.listSessions(roots, { offset, limit })
  )
  ipcMain.handle('claude:transcript', (_e, id: string) => ClaudeImport.getTranscript(id))
  ipcMain.handle(
    'claude:resume',
    (_e, id: string, cwd: string | undefined, name: string) =>
      sessions.resumeExternalClaudeSession(id, cwd, name)
  )
  ipcMain.handle('codex:available', () => CodexImport.available())
  ipcMain.handle('codex:list', (_e, roots?: string[], offset?: number, limit?: number) =>
    CodexImport.listSessions(roots, { offset, limit })
  )
  ipcMain.handle('codex:transcript', (_e, id: string) => CodexImport.getTranscript(id))
  ipcMain.handle(
    'codex:resume',
    (_e, id: string, cwd: string | undefined, name: string) =>
      sessions.resumeExternalCodexSession(id, cwd, name)
  )
  ipcMain.handle('cursorAgent:available', () => CursorAgentImport.available())
  ipcMain.handle('cursorAgent:list', (_e, roots?: string[], offset?: number, limit?: number) =>
    CursorAgentImport.listSessions(roots, { offset, limit })
  )
  ipcMain.handle('cursorAgent:transcript', (_e, id: string) => CursorAgentImport.getTranscript(id))
  ipcMain.handle(
    'cursorAgent:resume',
    (_e, id: string, cwd: string | undefined, name: string) =>
      sessions.resumeExternalCursorSession(id, cwd, name)
  )
  ipcMain.handle('update:check', () => UpdateService.check())
  ipcMain.handle('update:download', () => UpdateService.download())
  ipcMain.handle('update:install', () => UpdateService.install())
  ipcMain.handle('update:status', () => UpdateService.status())
  // app-level devtools (the browser pane owns page devtools) — palette-only so
  // it never sits on a menu accelerator that could hijack the browser
  ipcMain.handle('app:toggle-devtools', (e) => e.sender.toggleDevTools())
  ipcMain.handle('auth:status', () =>
    AuthService.status(settings.getSetting('codexBinaryPath'), settings.getSetting('cursorBinaryPath'))
  )
  ipcMain.handle('auth:login', (_e, backend: 'claude' | 'codex' | 'cursor') =>
    AuthService.openLogin(backend)
  )
  ipcMain.handle('models:codex', () => CodexModelService.list(settings.getSetting('codexBinaryPath')))
  ipcMain.handle('models:cursor', () =>
    CursorModelService.list(settings.getSetting('cursorBinaryPath'))
  )
  ipcMain.handle('usage:claude', (_e, force?: boolean) =>
    UsageService.claudeUsage(settings.getSetting('claudeBinaryPath'), force, {
      get: (k) => settings.getSetting(k),
      set: (k, v) => settings.setSetting(k, v)
    })
  )
  ipcMain.handle('usage:codex', (_e, force?: boolean) =>
    UsageService.codexUsage(settings.getSetting('codexBinaryPath'), force, {
      get: (k) => settings.getSetting(k),
      set: (k, v) => settings.setSetting(k, v)
    })
  )
  ipcMain.handle('usage:cursor', (_e, force?: boolean) =>
    UsageService.cursorUsage(settings.getSetting('cursorBinaryPath'), force, {
      get: (k) => settings.getSetting(k),
      set: (k, v) => settings.setSetting(k, v)
    })
  )
  ipcMain.handle('remote:test', (_e, host: string) => RemoteService.testHost(host))
  ipcMain.handle('remote:tunnel', async (_e, sessionId: string, remotePort: number) => {
    const session = store.getSession(sessionId)
    if (session?.environment !== 'ssh') throw new Error('Tunnels only apply to SSH sessions.')
    const host = sessions.remoteHost(session.remoteHostId)?.host
    if (!host) throw new Error('This session has no SSH host configured.')
    return openTunnel(sessionId, host, remotePort)
  })
  ipcMain.handle('sessions:list-archived', () => store.listArchivedSessions())
  ipcMain.handle('sessions:unarchive', (_e, sessionId: string) => {
    const s = store.updateSession(sessionId, { status: 'idle' })
    return s
  })
  ipcMain.handle('sessions:create', async (_e, req: NewSessionRequest) => {
    const session = await sessions.createSession(req)
    // spin up ONLY the processes the user opted in (Angel's spec: a per-process
    // "run on agent start" checkbox, OFF by default — everything else waits for
    // the Processes tab's Start button)
    try {
      const raw = settings.getSetting(`devProcesses:${session.projectId}`)
      const procs = raw
        ? (JSON.parse(raw) as { name: string; command: string; autoStart?: boolean }[])
        : []
      const auto = procs
        .map((p, i) => ({ ...p, i }))
        .filter((p) => p.autoStart && p.command?.trim())
      if (auto.length) {
        const startProcs = async (): Promise<void> => {
          const cwd = await sessions.ensureWorkdir(session.id)
          const env =
            session.environment === 'ssh' ? undefined : browserControl?.sessionEnv(session.id)
          auto.forEach((p) =>
            ptyService?.startCommand(`dev:${session.id}:${p.i}`, cwd, p.command, 120, 30, env)
          )
        }
        // worktrees never launch into a half-provisioned tree: with a setup
        // script, wait for it to finish CLEANLY; without one, the user's
        // explicit opt-in starts right away
        const setup = session.environment === 'worktree' ? sessions.setupResult(session.id) : null
        if (setup) {
          void setup.then((ok) => {
            if (ok) void startProcs()
          })
        } else {
          void startProcs()
        }
      }
    } catch {
      /* bad config shouldn't block session creation */
    }
    return session
  })
  ipcMain.handle('sessions:prompt', (_e, sessionId: string, text: string, images?: PromptImage[]) =>
    sessions.prompt(sessionId, text, images)
  )
  ipcMain.handle('dialog:pick-attachments', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map((p) => FileService.readExternalAttachment(p)))
  })
  ipcMain.handle('sessions:interrupt', (_e, sessionId: string) => sessions.interrupt(sessionId))
  ipcMain.handle('sessions:archive', (_e, sessionId: string) => sessions.archive(sessionId))
  ipcMain.handle('sessions:drop-worktree', (_e, sessionId: string) =>
    sessions.dropWorktree(sessionId)
  )
  ipcMain.handle('sessions:recreate-worktree', (_e, sessionId: string) =>
    sessions.recreateWorktree(sessionId)
  )
  ipcMain.handle('sessions:rename', (_e, sessionId: string, title: string) =>
    sessions.rename(sessionId, title)
  )
  ipcMain.handle('sessions:respond-permission', (_e, sessionId: string, requestId: string, decision: string) =>
    sessions.respondPermission(sessionId, requestId, decision)
  )
  ipcMain.handle(
    'sessions:respond-question',
    (_e, sessionId: string, requestId: string, answers: QuestionAnswer[]) =>
      sessions.respondQuestion(sessionId, requestId, answers)
  )
  ipcMain.handle('sessions:duplicate', (_e, sessionId: string) =>
    sessions.duplicateSession(sessionId)
  )
  ipcMain.handle('sessions:retry', (_e, sessionId: string) => sessions.retry(sessionId))
  ipcMain.handle(
    'sessions:rewind',
    (_e, sessionId: string, originalText: string, occurrenceFromEnd: number, newText: string) =>
      sessions.rewind(sessionId, originalText, occurrenceFromEnd, newText)
  )
  ipcMain.handle('sessions:set-model', (_e, sessionId: string, model: string) =>
    sessions.setModel(sessionId, model)
  )
  ipcMain.handle(
    'sessions:set-permission-mode',
    (_e, sessionId: string, mode: PermissionMode) => sessions.setPermissionMode(sessionId, mode)
  )
  ipcMain.handle('sessions:set-effort', (_e, sessionId: string, effort: string) =>
    sessions.setEffort(sessionId, effort)
  )
  ipcMain.handle('sessions:get-effort', (_e, sessionId: string) =>
    settings.getSetting(`effort:${sessionId}`)
  )
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('settings:get', (_e, key: string) => settings.getSetting(key))
  ipcMain.handle('settings:set', (_e, key: string, value: string) => settings.setSetting(key, value))
  // per-backend agent default (agents.<backend>.<field>), workspace overriding
  // app — backs the New Agent dialog's pre-fill (model + permission mode)
  ipcMain.handle(
    'settings:resolve-agent-default',
    (_e, backend: string, field: string, projectId?: string) =>
      settings.resolveAgentDefault(backend, field, projectId)
  )
  // raw settings.json editing (files live outside session worktrees, so the
  // session-scoped file IPC can't reach them — dedicated surface instead)
  ipcMain.handle('settings-file:path', (_e, scope: SettingsChangeScope, projectId?: string) =>
    settings.filePath(scope, projectId)
  )
  ipcMain.handle('settings-file:read', (_e, scope: SettingsChangeScope, projectId?: string) =>
    settings.readRaw(scope, projectId)
  )
  ipcMain.handle(
    'settings-file:write',
    (_e, scope: SettingsChangeScope, text: string, projectId?: string) =>
      settings.writeRaw(scope, text, projectId)
  )
  ipcMain.handle('sessions:events', (_e, sessionId: string) => store.getEvents(sessionId))
  ipcMain.handle('sessions:changed-files', (_e, sessionId: string) =>
    sessions.changedFiles(sessionId)
  )
  ipcMain.handle('git:scoped-files', (_e, sessionId: string, scope: DiffScope) =>
    sessions.scopedFiles(sessionId, scope)
  )
  ipcMain.handle(
    'git:scoped-diff',
    (_e, sessionId: string, scope: DiffScope, path: string, ignoreWs?: boolean) =>
      sessions.scopedDiff(sessionId, scope, path, ignoreWs)
  )
  ipcMain.handle('git:scope-summary', (_e, sessionId: string) => sessions.scopeSummary(sessionId))
  ipcMain.handle('git:status', (_e, sessionId: string) => sessions.gitStatus(sessionId))
  ipcMain.handle('git:line-status', (_e, sessionId: string, path: string) =>
    sessions.gitLineStatus(sessionId, path)
  )
  ipcMain.handle('git:stage', (_e, sessionId: string, path: string) =>
    sessions.gitStage(sessionId, path)
  )
  ipcMain.handle('git:unstage', (_e, sessionId: string, path: string) =>
    sessions.gitUnstage(sessionId, path)
  )
  ipcMain.handle('git:discard', (_e, sessionId: string, path: string) =>
    sessions.gitDiscard(sessionId, path)
  )
  ipcMain.handle('sessions:file-diff', (_e, sessionId: string, path: string, ignoreWs?: boolean) =>
    sessions.fileDiff(sessionId, path, ignoreWs)
  )
  ipcMain.handle('sessions:media-diff', async (_e, sessionId: string, path: string) => {
    const cwd = await sessions.ensureWorkdir(sessionId)
    const session = store.getSession(sessionId)
    const via = session ? sessions.execFor(session) : undefined
    const baseRef = session?.baseRef || (session?.environment === 'ssh' ? 'HEAD' : '')
    const before = baseRef ? await GitService.fileDataUrlAtRef(cwd, baseRef, path, via) : null
    const after = await GitService.workingFileDataUrl(cwd, path, via)
    return { before, after }
  })
  ipcMain.handle('git:revert-hunk', (_e, sessionId: string, path: string, patch: string) =>
    sessions.revertHunk(sessionId, path, patch)
  )
  ipcMain.handle('git:stage-hunk', (_e, sessionId: string, path: string, patch: string) =>
    sessions.stageHunk(sessionId, path, patch)
  )
  ipcMain.handle('git:hunk-at', (_e, sessionId: string, path: string, line: number) =>
    sessions.hunkAtLine(sessionId, path, line)
  )
  ipcMain.handle('git:stage-hunk-at', (_e, sessionId: string, path: string, line: number) =>
    sessions.stageHunkAtLine(sessionId, path, line)
  )
  ipcMain.handle('git:revert-hunk-at', (_e, sessionId: string, path: string, line: number) =>
    sessions.revertHunkAtLine(sessionId, path, line)
  )
  ipcMain.handle('sessions:submit-review', (_e, sessionId: string, comments: ReviewComment[]) =>
    sessions.submitReview(sessionId, comments)
  )
  ipcMain.handle('sessions:commit', (_e, sessionId: string, message: string) =>
    sessions.commitSession(sessionId, message)
  )
  ipcMain.handle('sessions:commit-push', (_e, sessionId: string, message: string) =>
    sessions.commitPushSession(sessionId, message)
  )
  ipcMain.handle('sessions:current-branch', (_e, sessionId: string) =>
    sessions.currentBranch(sessionId)
  )
  ipcMain.handle(
    'sessions:branch-commit-push',
    (_e, sessionId: string, branch: string, message: string) =>
      sessions.branchCommitPushSession(sessionId, branch, message)
  )
  ipcMain.handle('sessions:resync', (_e, sessionId: string) => sessions.resyncExternal(sessionId))
  ipcMain.handle('sessions:agent-alive', (_e, sessionId: string) => sessions.agentAlive(sessionId))
  // the CLI's own permission allow/deny rules that apply to a session's cwd —
  // read-only surfacing (Angel: "read per agent already whitelisted permissions")
  ipcMain.handle('sessions:permission-rules', (_e, sessionId: string) => {
    const s = store.getSession(sessionId)
    if (!s || s.backend !== 'claude') return []
    const out: { rule: string; kind: 'allow' | 'deny'; source: string }[] = []
    const files: [string, string][] = [
      [join(homedir(), '.claude', 'settings.json'), 'user'],
      [join(homedir(), '.claude', 'settings.local.json'), 'user·local'],
      [join(s.cwd, '.claude', 'settings.json'), 'project'],
      [join(s.cwd, '.claude', 'settings.local.json'), 'project·local']
    ]
    for (const [file, source] of files) {
      try {
        const perms = (JSON.parse(readFileSync(file, 'utf8')) as {
          permissions?: { allow?: string[]; deny?: string[] }
        }).permissions
        for (const r of perms?.allow ?? []) out.push({ rule: r, kind: 'allow', source })
        for (const r of perms?.deny ?? []) out.push({ rule: r, kind: 'deny', source })
      } catch {
        /* missing/invalid file — skip */
      }
    }
    return out
  })
  ipcMain.handle('sessions:merge-base', (_e, sessionId: string) =>
    sessions.mergeSessionToBase(sessionId)
  )
  ipcMain.handle('sessions:create-pr', (_e, sessionId: string) =>
    sessions.createSessionPr(sessionId)
  )

  // ---- file browser ----
  // remote (ssh) sessions route file ops over the Exec seam; local unchanged
  const remoteFor = (sessionId: string): { exec: Exec } | undefined => {
    const s = store.getSession(sessionId)
    if (s?.environment !== 'ssh') return undefined
    const host = sessions.remoteHost(s.remoteHostId)?.host
    return host ? { exec: sshExec(host) } : undefined
  }
  // remote listings are slow-ish; a 5s cache keeps tree/@-mention lookups snappy
  const remoteListCache = new Map<string, { at: number; files: string[] }>()
  ipcMain.handle('files:list', async (_e, sessionId: string, relPath: string) =>
    FileService.listDir(await sessions.ensureWorkdir(sessionId), relPath, remoteFor(sessionId))
  )
  ipcMain.handle('files:read', async (_e, sessionId: string, relPath: string) =>
    FileService.readFile(await sessions.ensureWorkdir(sessionId), relPath, remoteFor(sessionId))
  )
  // ---- HTML preview protocol ----
  // The editor's HTML preview webview loads hang4r-preview://s/<sessionId>/<relPath>
  // so RELATIVE assets (img/css/js next to the file) resolve — a data: URL has
  // no base and could never load them. The entry document is served from the
  // live (possibly unsaved) editor buffer; everything else from the workdir.
  const previewDocs = new Map<string, string>() // `${sessionId}:${relPath}` → html
  ipcMain.handle('preview:set', (_e, sessionId: string, relPath: string, html: string) => {
    previewDocs.set(`${sessionId}:${relPath.replace(/^\.?\//, '')}`, html)
  })
  session.fromPartition('persist:hang4r-preview').protocol.handle('hang4r-preview', async (req) => {
    try {
      const u = new URL(req.url)
      // pathname: /<sessionId>/<relPath…>
      const [, sessionId, ...rest] = u.pathname.split('/')
      const rel = decodeURIComponent(rest.join('/'))
      const buffered = previewDocs.get(`${sessionId}:${rel}`)
      if (buffered !== undefined) {
        return new Response(buffered, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      const workdir = await sessions.ensureWorkdir(sessionId)
      const abs = pathResolve(workdir, rel)
      if (abs !== pathResolve(workdir) && !abs.startsWith(pathResolve(workdir) + pathSep)) {
        return new Response('forbidden', { status: 403 })
      }
      return await net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  ipcMain.handle('files:data-url', async (_e, sessionId: string, relPath: string) =>
    FileService.readFileDataUrl(
      await sessions.ensureWorkdir(sessionId),
      relPath,
      remoteFor(sessionId)
    )
  )
  ipcMain.handle('files:write', async (_e, sessionId: string, relPath: string, content: string) => {
    remoteListCache.delete(sessionId)
    return FileService.writeFile(
      await sessions.ensureWorkdir(sessionId),
      relPath,
      content,
      remoteFor(sessionId)
    )
  })
  ipcMain.handle('files:all', async (_e, sessionId: string) => {
    const remote = remoteFor(sessionId)
    if (remote) {
      const hit = remoteListCache.get(sessionId)
      if (hit && Date.now() - hit.at < 5_000) return hit.files
      const files = await FileService.listAllFiles(await sessions.ensureWorkdir(sessionId), remote)
      remoteListCache.set(sessionId, { at: Date.now(), files })
      return files
    }
    return FileService.listAllFiles(await sessions.ensureWorkdir(sessionId))
  })
  ipcMain.handle('files:sources', async (_e, sessionId: string) =>
    remoteFor(sessionId)
      ? [] // TS language service stays local-only on remote sessions
      : FileService.readSources(await sessions.ensureWorkdir(sessionId))
  )
  ipcMain.handle('files:search', async (_e, sessionId: string, query: string) =>
    remoteFor(sessionId)
      ? []
      : FileService.searchContent(await sessions.ensureWorkdir(sessionId), query)
  )
  ipcMain.handle('search:query', async (_e, sessionId: string, options: SearchOptions) =>
    SearchService.search(await sessions.ensureWorkdir(sessionId), options, remoteFor(sessionId))
  )
  ipcMain.handle('search:replace', async (_e, sessionId: string, req: ReplaceRequest) =>
    SearchService.replace(await sessions.ensureWorkdir(sessionId), req, remoteFor(sessionId))
  )
  ipcMain.handle('files:create', async (_e, sessionId: string, relPath: string) => {
    remoteListCache.delete(sessionId)
    return FileService.createFile(
      await sessions.ensureWorkdir(sessionId),
      relPath,
      remoteFor(sessionId)
    )
  })
  ipcMain.handle('files:mkdir', async (_e, sessionId: string, relPath: string) =>
    FileService.createDir(await sessions.ensureWorkdir(sessionId), relPath, remoteFor(sessionId))
  )
  ipcMain.handle('files:rename', async (_e, sessionId: string, from: string, to: string) => {
    remoteListCache.delete(sessionId)
    return FileService.rename(
      await sessions.ensureWorkdir(sessionId),
      from,
      to,
      remoteFor(sessionId)
    )
  })
  ipcMain.handle('files:remove', async (_e, sessionId: string, relPath: string) => {
    remoteListCache.delete(sessionId)
    return FileService.remove(
      await sessions.ensureWorkdir(sessionId),
      relPath,
      remoteFor(sessionId)
    )
  })
  ipcMain.handle('files:resolve', async (_e, sessionId: string, from: string, spec: string) =>
    remoteFor(sessionId)
      ? null
      : FileService.resolveImport(await sessions.ensureWorkdir(sessionId), from, spec)
  )
  ipcMain.handle('files:definition', async (_e, sessionId: string, symbol: string) =>
    remoteFor(sessionId)
      ? null
      : FileService.findDefinition(await sessions.ensureWorkdir(sessionId), symbol)
  )
  ipcMain.handle('files:tail', (_e, absPath: string) => FileService.tailFile(absPath))

  // ---- terminals ----
  const broadcastPty = (channel: string, id: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, id, payload)
    }
  }
  ptyService = new PtyService(
    (id, data) => broadcastPty('pty:data', id, data),
    (id, code) => broadcastPty('pty:exit', id, code)
  )
  ipcMain.handle(
    'pty:start',
    async (_e, id: string, sessionId: string, cols: number, rows: number) => {
      // resolve (and recreate if missing) the session's working directory
      const cwd = await sessions.ensureWorkdir(sessionId)
      // ssh sessions get a remote shell in the remote cwd (forced TTY)
      const session = store.getSession(sessionId)
      // workspace shell override beats the app default for local terminals
      const shell = (settings.resolve('terminalShell', session?.projectId) ?? '') || undefined
      const sshHost =
        session?.environment === 'ssh'
          ? sessions.remoteHost(session.remoteHostId)?.host
          : undefined
      // ssh terminals run on the remote host and can't reach the local socket, so
      // they get no browser-control env; local terminals do (skip ensure-tab there)
      const env = sshHost ? undefined : browserControl?.sessionEnv(sessionId)
      ptyService!.start(id, cwd, cols, rows, shell, sshHost, env)
    }
  )
  ipcMain.handle(
    'pty:start-command',
    async (_e, id: string, sessionId: string, command: string, cols: number, rows: number) => {
      const cwd = await sessions.ensureWorkdir(sessionId)
      const session = store.getSession(sessionId)
      const env = session?.environment === 'ssh' ? undefined : browserControl?.sessionEnv(sessionId)
      ptyService!.startCommand(id, cwd, command, cols, rows, env)
    }
  )
  ipcMain.handle('pty:running', (_e, id: string) => ptyService!.isRunning(id))
  ipcMain.handle('pty:write', (_e, id: string, data: string) => ptyService!.write(id, data))
  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptyService!.resize(id, cols, rows)
  )
  ipcMain.handle('pty:dispose', (_e, id: string) => ptyService!.dispose(id))
  ipcMain.handle('pty:clear', (_e, id: string) => ptyService!.clearBuffer(id))

  return sessions
}
