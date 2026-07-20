import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Worktree naming + setup-script honesty (Angel's Jul-15 live reports).
 *
 * Naming: the branch used to be hardcoded `hang4r/<slug>` and the folder got a
 * random 4-char hash even when the user explicitly named the session — so every
 * worktree read "hang4r/…" in wt/git tooling. Now: folder == branch == the
 * session name (sanitized, case preserved), collision → `-2`, prefix only via
 * the explicit `worktreeBranchPrefix` setting.
 *
 * Setup: the script now runs via the user's login shell, no longer blocks
 * session creation, and its outcome lands durably in the transcript.
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

function branches(repo: string): string[] {
  return execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo })
    .toString()
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
}

async function createWorktreeSession(
  page: LaunchedApp['page'],
  projectId: string,
  title: string,
  firstPrompt?: string
): Promise<{ id: string; cwd: string }> {
  return page.evaluate(
    ({ projectId, title, firstPrompt }) =>
      window.hang4r.createSession({
        projectId,
        backend: 'claude',
        environment: 'worktree',
        permissionMode: 'default',
        title,
        firstPrompt
      }),
    { projectId, title, firstPrompt }
  )
}

test('an explicitly named session gets EXACTLY that worktree + branch — no hang4r prefix, no hash', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)

  const session = await createWorktreeSession(page, project.id, 'FEAT-D98')

  // folder is the verbatim name (case preserved), inside the default container
  expect(session.cwd).toBe(join(repo, '.hang4r-worktrees', 'FEAT-D98'))
  expect(existsSync(session.cwd)).toBe(true)

  // branch == the name; nothing hang4r-flavored anywhere in the branch list
  const all = branches(repo)
  expect(all).toContain('FEAT-D98')
  expect(all.filter((b) => b.startsWith('hang4r/'))).toEqual([])
})

test('same name twice → the second worktree gets -2, never a clobber or a failure', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)

  const first = await createWorktreeSession(page, project.id, 'fix-login')
  const second = await createWorktreeSession(page, project.id, 'fix-login')

  expect(first.cwd).toBe(join(repo, '.hang4r-worktrees', 'fix-login'))
  expect(second.cwd).toBe(join(repo, '.hang4r-worktrees', 'fix-login-2'))
  expect(branches(repo)).toEqual(expect.arrayContaining(['fix-login', 'fix-login-2']))
})

test("a pre-existing branch of the same name collides to -2 — the user's branch is never touched", async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)

  // user already has a branch of that name — hang4r must not steal or clobber it
  execFileSync('git', ['branch', 'mybranch'], { cwd: repo })
  const session = await createWorktreeSession(page, project.id, 'mybranch')
  expect(session.cwd).toBe(join(repo, '.hang4r-worktrees', 'mybranch-2'))
  expect(branches(repo)).toEqual(expect.arrayContaining(['mybranch', 'mybranch-2']))
})

test('worktreeBranchPrefix namespaces the BRANCH only (workspace over app), folder stays clean', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(async () => {
    await window.hang4r.setSetting('worktreeBranchPrefix', 'agents/')
  })

  const session = await createWorktreeSession(page, project.id, 'FEAT-X')
  expect(session.cwd).toBe(join(repo, '.hang4r-worktrees', 'FEAT-X'))
  expect(branches(repo)).toContain('agents/FEAT-X')
})

test('titles sanitize to git-safe names, case preserved', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)

  const session = await createWorktreeSession(page, project.id, '↳ Fix the Login Flow! (v2)')
  const name = readdirSync(join(repo, '.hang4r-worktrees'))[0]
  expect(name).toBe('Fix-the-Login-Flow-v2')
  expect(session.cwd).toBe(join(repo, '.hang4r-worktrees', name))
  expect(branches(repo)).toContain(name)
})

test('setup failure: session creates instantly, the error lands DURABLY in the transcript, agent still works', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(async () => {
    await window.hang4r.setSetting('setupScript', 'echo boom-details >&2; exit 7')
  })

  await createWorktreeSession(page, project.id, 'setup-fails', 'hello')
  // bridge-created projects/sessions aren't in the sidebar until a reload;
  // reloading ALSO proves the failure note survives via replay, not just live
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'setup-fails' }).click()
  const tile = page.locator('.tile').first()

  // failure note is visible in the chat…
  await expect(tile.locator('.setup-note-error')).toContainText('exited 7', { timeout: 15_000 })
  await expect(tile.locator('.setup-note-error')).toContainText('boom-details')
  // …the first prompt still went through and the fake agent answered…
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  await expect(tile.locator('.msg-assistant').first()).toBeVisible()
  // …and the note SURVIVES the turn that used to wipe lastError
  await expect(tile.locator('.setup-note-error')).toContainText('exited 7')
})

test('setup runs in the BACKGROUND: the agent starts immediately, notes still land', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(async () => {
    // slow enough that a gated first prompt would visibly wait on it — the
    // agent must NOT (Angel's Jul-16 call: setup never parks the session)
    await window.hang4r.setSetting('setupScript', 'sleep 5 && echo ok > SETUP_DONE.txt')
  })

  const session = await createWorktreeSession(page, project.id, 'setup-ok', 'hello')
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'setup-ok' }).click()
  const tile = page.locator('.tile').first()
  // the fake agent goes idle while the 5s setup sleep is still running — the
  // turn provably did not wait for setup
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  expect(existsSync(join(session.cwd, 'SETUP_DONE.txt'))).toBe(false)

  // …and the setup still finishes + reports durably in the transcript
  await expect(tile.locator('.setup-note').nth(1)).toContainText('finished', { timeout: 10_000 })
  expect(existsSync(join(session.cwd, 'SETUP_DONE.txt'))).toBe(true)
  await expect(tile.locator('.setup-note').first()).toContainText('Running setup script')
})

test('dev processes: only autoStart-checked ones launch, and worktrees still wait for setup', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    async ({ pid }) => {
      await window.hang4r.setSetting('setupScript', 'sleep 1 && echo ok > SETUP_DONE.txt')
      // Angel's spec: per-process "run on agent start" checkbox, OFF by default
      await window.hang4r.setSetting(
        `devProcesses:${pid}`,
        JSON.stringify([
          { name: 'opted-in', command: 'touch AUTO_RAN.txt && sleep 30', autoStart: true },
          { name: 'default-off', command: 'touch MANUAL_ONLY.txt && sleep 30' }
        ])
      )
    },
    { pid: project.id }
  )

  // worktree: the opted-in process must NOT run before setup finishes…
  const wt = await createWorktreeSession(page, project.id, 'proc-order', 'hello')
  await page.waitForTimeout(400)
  expect(existsSync(join(wt.cwd, 'AUTO_RAN.txt'))).toBe(false) // setup still sleeping
  await expect
    .poll(() => existsSync(join(wt.cwd, 'AUTO_RAN.txt')), { timeout: 10_000 })
    .toBe(true) // …then starts once setup completed
  expect(existsSync(join(wt.cwd, 'SETUP_DONE.txt'))).toBe(true)
  // …while the unchecked process NEVER auto-starts
  await page.waitForTimeout(500)
  expect(existsSync(join(wt.cwd, 'MANUAL_ONLY.txt'))).toBe(false)

  // local session: opted-in starts right away, unchecked stays off
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'proc-local',
        firstPrompt: 'hello'
      }),
    { pid: project.id }
  )
  await expect
    .poll(() => existsSync(join(repo, 'AUTO_RAN.txt')), { timeout: 5_000 })
    .toBe(true)
  expect(existsSync(join(repo, 'MANUAL_ONLY.txt'))).toBe(false)
})

test('node_modules is VISIBLE in the file explorer tree but still skipped by ⌘P', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  // a realistic repo gitignores node_modules — ⌘P (git ls-files) must keep
  // excluding it while the TREE (plain readdir) shows it
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'ignore node_modules'], { cwd: repo })
  const project = await createProject(page, repo)
  await page.evaluate(async () => {
    // simulate what a setup script's `npm install` produces
    await window.hang4r.setSetting('setupScript', 'mkdir -p node_modules/left-pad; echo x > node_modules/left-pad/index.js')
  })

  const session = await createWorktreeSession(page, project.id, 'nm-visible', 'hello')
  // the tree listing shows node_modules once setup produced it (Angel's report:
  // install ran but the explorer hid the proof and made Refresh look broken)
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          const entries = await window.hang4r.listDir(id, '')
          return entries.map((e) => e.name)
        }, session.id),
      { timeout: 15_000 }
    )
    .toContain('node_modules')
  // …and descending into it works…
  const inner = await page.evaluate(
    (id) => window.hang4r.listDir(id, 'node_modules'),
    session.id
  )
  expect(inner.map((e) => e.name)).toContain('left-pad')
  // …while the ⌘P flat list still prunes its contents (20k-cap protection)
  const all = await page.evaluate((id) => window.hang4r.listAllFiles(id), session.id)
  expect(all.some((p) => p.includes('node_modules/'))).toBe(false)
})

test("a workspace-scope EMPTY setup script doesn't shadow the global one", async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    async ({ pid }) => {
      await window.hang4r.setSetting('setupScript', 'echo global > GLOBAL_RAN.txt')
      // the Settings UI saves the workspace field even when left empty — this
      // must fall through to the global script, not silently disable it
      await window.hang4r.setSetting(`setupScript:${pid}`, '')
    },
    { pid: project.id }
  )

  await createWorktreeSession(page, project.id, 'empty-shadow', 'hello')
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'empty-shadow' }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  const wt = join(repo, '.hang4r-worktrees', 'empty-shadow')
  expect(existsSync(join(wt, 'GLOBAL_RAN.txt'))).toBe(true)
})
