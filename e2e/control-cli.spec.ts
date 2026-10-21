import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'
import { BRIDGE_METHODS } from '../src/shared/bridge'
import { installCli, shimScript, uninstallCli } from '../src/main/services/cliInstall'
import { AppControlService } from '../src/main/services/appControlService'

/**
 * `hang4r sessions …` against the built app, with the real CLI as a subprocess
 * (as Buzz, a Slack bot or Codex would call it) and the fake agent behind it.
 */

const CLI = join(__dirname, '..', 'resources', 'ctl', 'hang4r-cli.js')

interface Run {
  status: number | null
  stdout: string
  stderr: string
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
  err: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** ASYNC on purpose (see browser-cli.spec.ts): a blocking spawn would stall the Electron renderer. */
function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  opts?: { stdin?: string; onChild?: (kill: () => void) => void }
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, HANG4R_CTL_SOCK: '', HANG4R_CTL_TOKEN: '', ...env }
    })
    opts?.onChild?.(() => child.kill('SIGKILL'))
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    if (opts?.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
    child.on('close', (status) => {
      const parse = (s: string): unknown => {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      }
      resolve({ status, stdout, stderr, json: parse(stdout), err: parse(stderr) })
    })
  })
}

test.describe('control CLI', () => {
  test.describe.configure({ mode: 'serial' })
  let launched: LaunchedApp
  let repo: string
  let project: string
  let env: Record<string, string>

  test.beforeAll(async () => {
    launched = await launchApp()
    repo = makeScratchRepo()
    project = basename(repo)
    await createProject(launched.page, repo)
    env = { HANG4R_USER_DATA: launched.userDataDir }
  })

  test.afterAll(async () => {
    await launched?.app.close().catch(() => {})
  })

  const cli = (...args: string[]): Promise<Run> => runCli(args, env)
  const events = (sessionId: string): Promise<{ kind: string; [k: string]: unknown }[]> =>
    launched.page.evaluate(
      (sid) => window.hang4r.getSessionEvents(sid).then((evs) => evs.map((e) => e.event)),
      sessionId
    ) as never

  test('status, projects, models answer', async () => {
    const status = await cli('status')
    expect(status.status).toBe(0)
    expect(status.json.ok).toBe(true)
    expect(realpathSync(status.json.userData)).toBe(realpathSync(launched.userDataDir))
    const projects = await cli('projects')
    expect(projects.json.projects.map((p: { name: string }) => p.name)).toContain(project)
    const models = await cli('models', '--backend', 'claude')
    expect(models.status).toBe(0)
    expect(models.json.models.length).toBeGreaterThan(0)
  })

  test('new --wait: turn-complete, origin recorded, sent text untouched, default env = worktree', async () => {
    const r = await cli('sessions', 'new', 'hi', '--project', project, '--wait', '--json', '--as', 'test')
    expect(r.status).toBe(0)
    expect(r.json.reason).toBe('turn-complete')
    expect(r.json.result).toBeTruthy()
    expect(r.json.session.origin).toBe('cli:test')
    // omitted --env = the Start-agent dialog's default
    expect(r.json.session.environment).toBe('worktree')
    const listed = await launched.page.evaluate(() => window.hang4r.listSessions())
    expect(listed.find((s) => s.id === r.json.session.id)?.origin).toBe('cli:test')
    const userText = (await events(r.json.session.id)).find((e) => e.kind === 'user-text')
    expect(userText).toMatchObject({ text: 'hi', origin: 'cli:test' })
    expect(userText?.label).toBeUndefined()
  })

  test('a session created in the app has no origin, and its own prompts carry none', async () => {
    const created = await launched.page.evaluate(
      (repoPath) =>
        window.hang4r.listProjects().then((ps) => {
          const p = ps.find((x) => x.path === repoPath)!
          return window.hang4r.createSession({
            projectId: p.id,
            backend: 'claude',
            environment: 'local',
            permissionMode: 'default',
            title: 'from the app',
            firstPrompt: 'plain'
          })
        }),
      repo
    )
    expect(created.origin ?? null).toBeNull()
    await expect
      .poll(async () =>
        (await events(created.id)).some((e) => e.kind === 'turn-complete')
      )
      .toBe(true)
    // …until an outside caller continues it: that turn (and only that turn) is labelled
    const sent = await cli('sessions', 'send', created.id, 'from buzz', '--wait', '--as', 'buzz')
    expect(sent.status).toBe(0)
    const users = (await events(created.id)).filter((e) => e.kind === 'user-text')
    expect(users.map((u) => [u.text, u.origin ?? null])).toEqual([
      ['plain', null],
      ['from buzz', 'cli:buzz']
    ])
  })

  test('no prompt = idle session; send --wait runs a turn; prompt via stdin and file', async () => {
    const made = await cli('sessions', 'new', '--project', project, '--env', 'local')
    expect(made.status).toBe(0)
    expect(made.json.session.status).toBe('idle')
    const id = made.json.session.id
    const sent = await cli('sessions', 'send', id, 'go', '--wait')
    expect(sent.status).toBe(0)
    expect(sent.json.reason).toBe('turn-complete')
    const piped = await runCli(['sessions', 'send', id, '-', '--wait'], env, { stdin: 'from stdin\n' })
    expect(piped.status).toBe(0)
    const file = join(mkdtempSync(join(tmpdir(), 'h4r-prompt-')), 'p.txt')
    writeFileSync(file, 'from file')
    const viaFile = await cli('sessions', 'new', '--project', project, '--env', 'local', '--prompt-file', file, '--wait')
    expect(viaFile.status).toBe(0)
    const texts = (await events(id)).filter((e) => e.kind === 'user-text').map((e) => e.text)
    expect(texts).toEqual(['go', 'from stdin\n'])
  })

  test('send on a running session exits 5; interrupt returns it to idle; a stale turn-complete never satisfies a wait', async () => {
    const made = await cli('sessions', 'new', 'slow turn 6000', '--project', project, '--env', 'local')
    expect(made.status).toBe(0)
    const id = made.json.session.id
    expect(made.json.session.status).toBe('running')
    const busy = await cli('sessions', 'send', id, 'too soon')
    expect(busy.status).toBe(5)
    expect(busy.err.error.code).toBe('busy')

    const stopped = await cli('sessions', 'interrupt', id)
    expect(stopped.status).toBe(0)
    expect(stopped.json.session.status).toBe('idle')
    // nothing in flight: reported as idle, not as a success with the old result
    const idle = await cli('sessions', 'wait', id)
    expect(idle.status).toBe(0)
    expect(idle.json.reason).toBe('idle')
    expect(idle.json.result).toBeUndefined()

    // the interrupt left a turn-complete in the transcript; the NEW turn's wait must ignore it
    const slow = await cli('sessions', 'send', id, 'slow turn 6000', '--wait', '--timeout', '1')
    expect(slow.status).toBe(4)
    expect(slow.json.reason).toBe('timeout')
    expect(slow.json.session.status).toBe('running')
    await cli('sessions', 'interrupt', id)
  })

  test('permission: wait exits 3 with the request, stays pending, respond allow completes; a dead request exits 7', async () => {
    const made = await cli('sessions', 'new', 'ask permission', '--project', project, '--env', 'local')
    const id = made.json.session.id
    const blocked = await cli('sessions', 'wait', id)
    expect(blocked.status).toBe(3)
    expect(blocked.json.reason).toBe('needs-input')
    const pending = blocked.json.session.pending
    expect(pending.kind).toBe('permission')
    expect(pending.options).toContain('allow')

    // never auto-resolved
    await new Promise((r) => setTimeout(r, 2500))
    const still = await cli('sessions', 'show', id)
    expect(still.json.session.pending.requestId).toBe(pending.requestId)
    expect(still.json.session.status).toBe('running')

    const bad = await cli('sessions', 'respond', id, pending.requestId, 'maybe')
    expect(bad.status).toBe(2)
    const ok = await cli('sessions', 'respond', id, pending.requestId, 'allow', '--wait')
    expect(ok.status).toBe(0)
    expect(ok.json.reason).toBe('turn-complete')
    // answering it again: the request is no longer live
    const again = await cli('sessions', 'respond', id, pending.requestId, 'allow')
    expect(again.status).toBe(7)

    // a request left unanswered when the turn is interrupted is just as dead
    const second = await cli('sessions', 'new', 'ask permission', '--project', project, '--env', 'local')
    const sid = second.json.session.id
    const w = await cli('sessions', 'wait', sid)
    expect(w.status).toBe(3)
    await cli('sessions', 'interrupt', sid)
    const dead = await cli('sessions', 'respond', sid, w.json.session.pending.requestId, 'allow')
    expect(dead.status).toBe(7)
    expect((await cli('sessions', 'show', sid)).json.session.pending).toBeNull()
  })

  test('question: --option answers it', async () => {
    const made = await cli('sessions', 'new', 'ask a question', '--project', project, '--env', 'local')
    const id = made.json.session.id
    const blocked = await cli('sessions', 'wait', id)
    expect(blocked.status).toBe(3)
    const q = blocked.json.session.pending
    expect(q.kind).toBe('question')
    expect(q.questions[0].options.map((o: { id: string }) => o.id)).toEqual(['red', 'blue'])
    const wrong = await cli('sessions', 'respond', id, q.requestId, '--option', 'green')
    expect(wrong.status).toBe(2)
    const done = await cli('sessions', 'respond', id, q.requestId, '--option', 'blue', '--wait')
    expect(done.status).toBe(0)
    expect(done.json.result).toBe('answered: blue')
  })

  test('wait --timeout 1 on a slow turn exits 4 and leaves the session running', async () => {
    const made = await cli('sessions', 'new', 'slow turn 4000', '--project', project, '--env', 'local')
    const id = made.json.session.id
    const r = await cli('sessions', 'wait', id, '--timeout', '1')
    expect(r.status).toBe(4)
    expect(r.json.reason).toBe('timeout')
    expect((await cli('sessions', 'show', id)).json.session.status).toBe('running')
    // and the turn it was waiting on still finishes on its own
    const end = await cli('sessions', 'wait', id, '--timeout', '15')
    expect(end.status).toBe(0)
    expect(end.json.reason).toBe('turn-complete')
  })

  test('an errored turn exits 6', async () => {
    const r = await cli('sessions', 'new', 'trigger error', '--project', project, '--env', 'local', '--wait')
    expect(r.status).toBe(6)
    expect(r.json.reason).toBe('error')
    expect(r.json.isError).toBe(true)
  })

  test('list and show', async () => {
    const list = await cli('sessions', '--limit', '3')
    expect(list.status).toBe(0)
    expect(list.json.sessions.length).toBe(3)
    const id = list.json.sessions[0].id
    const show = await cli('sessions', 'show', id)
    expect(show.json.session.id).toBe(id)
    expect(Array.isArray(show.json.events)).toBe(true)
  })

  test('exit codes: usage, not found, project resolution', async () => {
    expect((await cli('sessions', 'bogus')).status).toBe(2)
    expect((await cli('sessions', 'new', '--nope')).status).toBe(2)
    expect((await cli('sessions', 'show', '00000000-0000-0000-0000-000000000000')).status).toBe(7)
    const noProject = await cli('sessions', 'new', 'x', '--project', 'does-not-exist')
    expect(noProject.status).toBe(7)
    // no --project and the cwd (the test runner's) is in no project
    const ambiguous = await cli('sessions', 'new', 'x')
    expect(ambiguous.status).toBe(2)
    expect((await cli('sessions', 'new', 'x', '--project', project, '--permission-mode', 'nope')).status).toBe(2)
    expect((await cli('sessions', 'new', 'x', '--project', project, '--env', 'ssh')).status).toBe(2)
  })

  test('any permission mode is allowed from the CLI, bypass included', async () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
      const r = await cli('sessions', 'new', '--project', project, '--env', 'local', '--permission-mode', mode)
      expect(r.status).toBe(0)
      expect(r.json.session.permissionMode).toBe(mode)
    }
  })

  test('a removed worktree fails with exit 9 (no dialog); --rebuild-worktree recreates it', async () => {
    const made = await cli('sessions', 'new', 'hi', '--project', project, '--env', 'worktree', '--wait')
    expect(made.status).toBe(0)
    const { id, cwd } = made.json.session
    rmSync(cwd, { recursive: true, force: true })
    // the app has no adapter cache problem: a plain send must not hang on a modal
    const refused = await cli('sessions', 'send', id, 'again')
    expect(refused.status).toBe(9)
    expect(refused.err.error.code).toBe('worktree-missing')
    // …and the refusal must not have wedged the session
    expect((await cli('sessions', 'show', id)).json.session.status).toBe('idle')
    const rebuilt = await cli('sessions', 'send', id, 'again', '--rebuild-worktree', '--wait')
    expect(rebuilt.status).toBe(0)
    expect(existsSync(cwd)).toBe(true)
  })

  test('auth and reachability', async () => {
    const sock = join(launched.userDataDir, 'ctl.sock')
    const badToken = await runCli(['status'], { HANG4R_CTL_SOCK: sock, HANG4R_CTL_TOKEN: 'wrong' })
    expect(badToken.status).toBe(11)
    expect(badToken.err.error.code).toBe('auth')
    const t0 = Date.now()
    const down = await runCli(['status'], { HANG4R_USER_DATA: join(tmpdir(), 'h4r-no-such-dir') })
    expect(down.status).toBe(10)
    expect(down.err.error.message).toContain('--launch')
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  test('closing the caller drops its wait (no leaked subscription)', async () => {
    const made = await cli('sessions', 'new', 'slow turn 8000', '--project', project, '--env', 'local')
    const id = made.json.session.id
    let kill = (): void => {}
    const waiting = runCli(['sessions', 'wait', id], env, { onChild: (k) => (kill = k) })
    await expect.poll(async () => (await cli('status')).json.waiters).toBe(1)
    kill()
    await waiting
    await expect.poll(async () => (await cli('status')).json.waiters).toBe(0)
    await cli('sessions', 'interrupt', id)
  })

  test('CLI source never touches the CLI agents state or the database', async () => {
    const files = [
      CLI,
      join(__dirname, '..', 'src', 'main', 'services', 'appControlService.ts'),
      join(__dirname, '..', 'src', 'main', 'services', 'cliInstall.ts')
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toContain('.claude')
      expect(src, f).not.toContain('hang4r.db')
    }
  })

  test('hang4r quitting mid-wait exits 10', async () => {
    const made = await cli('sessions', 'new', 'slow turn 20000', '--project', project, '--env', 'local')
    const id = made.json.session.id
    const waiting = cli('sessions', 'wait', id)
    await expect.poll(async () => (await cli('status')).json.waiters).toBe(1)
    await launched.app.close()
    const r = await waiting
    expect(r.status).toBe(10)
    expect(r.err.error.message).toContain('app-quit')
  })
})

test('browser behaviour is unchanged: still session-bound, still its own help', async () => {
  const noSession = await runCli(['browser', 'tabs'], {
    HANG4R_SESSION_ID: '',
    HANG4R_CTL_SOCK: join(tmpdir(), 'x.sock'),
    HANG4R_CTL_TOKEN: 't'
  })
  expect(noSession.status).toBe(1)
  expect(noSession.stderr).toContain('HANG4R_SESSION_ID is not set')
  const help = await runCli(['browser', '--help'], {})
  expect(help.stdout).toContain("hang4r browser — drive & assert against this session's embedded browser pane.")
})

test('BRIDGE_METHODS is exactly the mobile list', () => {
  expect([...BRIDGE_METHODS]).toEqual([
    'listProjects',
    'listSessions',
    'listArchivedSessions',
    'getSessionEvents',
    'getSessionEventsPage',
    'prompt',
    'interrupt',
    'createSession',
    'respondPermission',
    'respondQuestion',
    'renameSession',
    'archiveSession',
    'unarchiveSession',
    'retrySession',
    'authStatus',
    'listCodexModels',
    'listCursorModels',
    'resolveAgentDefault',
    'scopeSummary',
    'scopedFiles',
    'scopedDiff',
    'submitReview',
    'markSeen',
    'setSessionModel',
    'setSessionPermissionMode',
    'claudeUsage',
    'codexUsage',
    'cursorUsage',
    'appVersion',
    'agentAlive',
    'currentBranch',
    'resyncSession',
    'sidebarState',
    'markUnseen',
    'rewindSession'
  ])
})

test('--launch polls until the socket accepts, and gives up at the deadline', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pollUntil } = require(CLI) as {
    pollUntil: (probe: () => Promise<boolean>, timeoutMs: number, intervalMs: number) => Promise<boolean>
  }
  let calls = 0
  expect(await pollUntil(async () => ++calls >= 3, 2000, 10)).toBe(true)
  expect(calls).toBe(3)
  const t0 = Date.now()
  expect(await pollUntil(async () => false, 120, 20)).toBe(false)
  expect(Date.now() - t0).toBeLessThan(1000)
})

test('installCli: symlinks into ~/.local/bin, refuses to replace anything else, uninstalls only its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'h4r-home-'))
  const shim = join(mkdtempSync(join(tmpdir(), 'h4r-shim-')), 'hang4r')
  writeFileSync(shim, '#!/bin/sh\n')
  const base = { shimPath: shim, appPath: '/Applications/hang4r.app/Contents/MacOS/hang4r', home }

  const onPath = await installCli({ ...base, pathValue: async () => '/usr/bin:' + join(home, '.local', 'bin') })
  expect(onPath.ok).toBe(true)
  expect(onPath.onPath).toBe(true)
  expect(readlinkSync(join(home, '.local', 'bin', 'hang4r'))).toBe(shim)
  // idempotent
  expect((await installCli({ ...base, pathValue: async () => '/usr/bin' })).ok).toBe(true)

  const offPath = await installCli({ ...base, pathValue: async () => '/usr/bin' })
  expect(offPath.onPath).toBe(false)
  expect(offPath.pathLine).toBe('export PATH="$HOME/.local/bin:$PATH"')

  expect((await uninstallCli({ ...base, pathValue: async () => '' })).ok).toBe(true)
  expect(existsSync(join(home, '.local', 'bin', 'hang4r'))).toBe(false)

  // a regular file already there is never replaced, and uninstall never removes it
  const link = join(home, '.local', 'bin', 'hang4r')
  writeFileSync(link, 'someone else\n')
  const refused = await installCli({ ...base, pathValue: async () => '' })
  expect(refused.ok).toBe(false)
  expect(refused.reason).toBe('exists')
  expect((await uninstallCli({ ...base, pathValue: async () => '' })).ok).toBe(false)
  expect(readFileSync(link, 'utf8')).toBe('someone else\n')
  // …nor a symlink that points somewhere else
  rmSync(link)
  symlinkSync('/usr/bin/true', link)
  expect((await installCli({ ...base, pathValue: async () => '' })).reason).toBe('exists')
  expect(lstatSync(link).isSymbolicLink() && readlinkSync(link)).toBe('/usr/bin/true')

  // a quarantined app runs from a throwaway mount: no link to it
  const translocated = await installCli({
    ...base,
    home: mkdtempSync(join(tmpdir(), 'h4r-home-')),
    appPath: '/private/var/folders/xx/AppTranslocation/ABC/d/hang4r.app/Contents/MacOS/hang4r',
    pathValue: async () => ''
  })
  expect(translocated.ok).toBe(false)
  expect(translocated.reason).toBe('translocated')
})

test('the shim falls back to /Applications/hang4r.app, then fails readably', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h4r-shimtest-'))
  const fakeApp = join(dir, 'hang4r.app')
  const exe = join(fakeApp, 'Contents', 'MacOS', 'hang4r')
  const cliJs = join(fakeApp, 'Contents', 'Resources', 'ctl', 'hang4r-cli.js')
  mkdirSync(join(fakeApp, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(fakeApp, 'Contents', 'Resources', 'ctl'), { recursive: true })
  writeFileSync(exe, '#!/bin/sh\necho "fallback ran $1"\n')
  chmodSync(exe, 0o755)
  writeFileSync(cliJs, '// stub\n')

  const run = (script: string): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const file = join(dir, `shim-${Math.random().toString(36).slice(2)}`)
      writeFileSync(file, script, { mode: 0o755 })
      const child = spawn(file, ['arg1'])
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })

  const fell = await run(shimScript('/nonexistent/electron', '/nonexistent/cli.js', fakeApp))
  expect(fell.status).toBe(0)
  expect(fell.stdout).toContain('fallback ran')
  const none = await run(shimScript('/nonexistent/electron', '/nonexistent/cli.js', join(dir, 'missing.app')))
  expect(none.status).toBe(10)
  expect(none.stderr).toContain("can't find the hang4r app")
})

test('installCli over IPC is wired (HOME redirected so the real one is never touched)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'h4r-home-'))
  const l = await launchApp({ env: { HOME: home } })
  try {
    // never call into the app unless it really resolves HOME to the temp dir
    const seen = await l.app.evaluate(() => process.env.HOME)
    expect(seen).toBe(home)
    const result = await l.page.evaluate(() => window.hang4r.installCli())
    expect(result.linkPath).toBe(join(home, '.local', 'bin', 'hang4r'))
    expect(result.ok).toBe(true)
    expect(realpathSync(readlinkSync(result.linkPath))).toBe(
      realpathSync(join(l.userDataDir, 'bin', 'hang4r'))
    )
    const removed = await l.page.evaluate(() => window.hang4r.uninstallCli())
    expect(removed.ok).toBe(true)
    expect(existsSync(result.linkPath)).toBe(false)
  } finally {
    await l.app.close().catch(() => {})
  }
})

test('wait is not re-evaluated per streamed token', () => {
  // waiters are poked from the same broadcast the renderer gets, which carries every
  // block-delta. Only events that can end or block a turn, and status changes, may wake one.
  const svc = new AppControlService({} as never)
  let wakes = 0
  const waiters = (svc as unknown as { waiters: Set<unknown> }).waiters
  waiters.add({ sessionId: 's1', check: () => void wakes++ })
  const ev = (seq: number, event: Record<string, unknown>): never =>
    ({ sessionId: 's1', seq, ts: 0, event }) as never

  for (let i = 0; i < 200; i++) {
    svc.onAgentEvent(ev(0, { kind: 'block-delta', text: 'x' })) // transient
    svc.onAgentEvent(ev(10 + i, { kind: 'block-delta', text: 'x' })) // even if persisted
    svc.onAgentEvent(ev(300 + i, { kind: 'block-final' }))
    svc.onAgentEvent(ev(600 + i, { kind: 'usage' }))
  }
  svc.onAgentEvent({ sessionId: 'other', seq: 5, ts: 0, event: { kind: 'turn-complete' } } as never)
  expect(wakes).toBe(0)

  svc.onAgentEvent(ev(900, { kind: 'turn-complete' }))
  svc.onAgentEvent(ev(901, { kind: 'exit' }))
  svc.onAgentEvent(ev(902, { kind: 'permission-request' }))
  svc.onAgentEvent(ev(903, { kind: 'permission-resolved' }))
  svc.onAgentEvent(ev(904, { kind: 'question-request' }))
  svc.onAgentEvent(ev(905, { kind: 'question-resolved' }))
  expect(wakes).toBe(6)

  const upd = (status: string): never => ({ id: 's1', status }) as never
  svc.onSessionUpdated(upd('running')) // first sighting
  svc.onSessionUpdated(upd('running')) // a title/cost edit: same status
  svc.onSessionUpdated(upd('running'))
  expect(wakes).toBe(7)
  svc.onSessionUpdated(upd('idle'))
  expect(wakes).toBe(8)
})

test('--launch only honors HANG4R_LAUNCH_CMD under the fake-agent env', async () => {
  // HANG4R_LAUNCH_CMD reaches /bin/sh -c; a production CLI must ignore it. `open` is
  // shadowed on PATH so the fallback never starts the real app.
  const dir = mkdtempSync(join(tmpdir(), 'h4r-launch-'))
  const fakeBin = join(dir, 'bin')
  mkdirSync(fakeBin)
  const openMarker = join(dir, 'open-ran')
  const cmdMarker = join(dir, 'cmd-ran')
  writeFileSync(join(fakeBin, 'open'), `#!/bin/sh\ntouch '${openMarker}'\n`)
  chmodSync(join(fakeBin, 'open'), 0o755)
  const base = {
    HANG4R_USER_DATA: join(dir, 'no-such-userdata'),
    HANG4R_LAUNCH_CMD: `touch '${cmdMarker}'`,
    HANG4R_LAUNCH_TIMEOUT_MS: '400',
    PATH: `${fakeBin}:${process.env.PATH}`
  }
  await runCli(['status', '--launch'], { ...base, HANG4R_FAKE_AGENT: '' })
  expect(existsSync(cmdMarker)).toBe(false) // ignored outside the e2e env
  expect(existsSync(openMarker)).toBe(true) // fell back to the normal launcher
  rmSync(openMarker)
  await runCli(['status', '--launch'], { ...base, HANG4R_FAKE_AGENT: '1' })
  expect(existsSync(cmdMarker)).toBe(true)
  expect(existsSync(openMarker)).toBe(false)
})
