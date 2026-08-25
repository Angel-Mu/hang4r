import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "how about subagents running? processes running? are those also covered?"
 *
 * Subagents are in-process inside the CLI, so a live subagent means the session
 * is 'running' and the existing agent count already covers it. A
 * `run_in_background` Bash task does NOT: it outlives its turn, so the session
 * sits IDLE while a dev server keeps running — and the guard counted only
 * sessions and ptys, never these.
 */
let launched: LaunchedApp | null = null
let holder: ChildProcess | null = null

test.afterEach(async () => {
  await launched?.page
    .evaluate(() => window.hang4r.onQuitConfirm(() => void window.hang4r.answerQuitConfirm(true)))
    .catch(() => {})
  await launched?.app.close().catch(() => {})
  launched = null
  if (holder?.pid) {
    try {
      process.kill(-holder.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  holder = null
})

/** Hold the task's output file open, which is exactly how a real
 *  `run_in_background` command reads as alive (lsof -t <outputPath>). */
function holdOpen(path: string): ChildProcess {
  const p = spawn('sh', ['-c', `exec 3>> "${path}"; sleep 100000`], { detached: true })
  p.unref()
  return p
}

/** the session is created over IPC, so no tile is mounted — read the store */
async function waitIdle(page: LaunchedApp['page']): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(() => window.hang4r.listSessions().then((l) => l[0]?.status)),
      { timeout: 20_000 }
    )
    .toBe('idle')
}

async function probeQuit(l: LaunchedApp): Promise<{ fired: boolean; message: string }> {
  await l.page.evaluate(() => {
    ;(window as unknown as { __q: unknown }).__q = null
    window.hang4r.onQuitConfirm((i) => {
      ;(window as unknown as { __q: unknown }).__q = i
    })
  })
  await l.app.evaluate(({ app }) => app.quit())
  for (let i = 0; i < 40; i++) {
    const info = await l.page
      .evaluate(() => (window as unknown as { __q: { message: string } | null }).__q)
      .catch(() => null)
    if (info) return { fired: true, message: info.message }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { fired: false, message: '' }
}

test('an idle session with a live background task still warns before quitting', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)

  // one full turn: the fake agent emits a run_in_background Bash task whose
  // output file is <cwd>/.hang4r-bg-1.log, then the session goes idle
  await page.evaluate(
    (pid) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'bg-task',
        firstPrompt: 'do a turn'
      }),
    project.id
  )
  await waitIdle(page)

  const log = join(repo, '.hang4r-bg-1.log')
  expect(existsSync(log)).toBe(true)
  holder = holdOpen(log)
  await new Promise((r) => setTimeout(r, 800)) // let lsof see the writer

  const quit = await probeQuit(launched)
  expect(quit.fired).toBe(true)
  expect(quit.message.toLowerCase()).toContain('background')
})

test('a finished background task does NOT warn (no live writer, no false prompt)', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)

  await page.evaluate(
    (pid) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'bg-done',
        firstPrompt: 'do a turn'
      }),
    project.id
  )
  await waitIdle(page)

  // nobody holds the log open → the task already ended → quitting must not nag
  const quit = await probeQuit(launched)
  expect(quit.fired).toBe(false)
})

test('a turn with a live subagent warns — the session reads running the whole time', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  // this prompt parks the turn on a permission ask, and the fake agent runs its
  // subagent BEFORE that hold — so the subagent thread is live while we probe
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('ask permission to do a thing')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-running')).toBeVisible({ timeout: 15_000 })
  await tile.getByRole('button', { name: 'Subagents' }).click()
  await expect(tile.locator('.subagent-type').first()).toContainText('Explore', { timeout: 15_000 })

  const quit = await probeQuit(launched)
  expect(quit.fired).toBe(true)
  expect(quit.message.toLowerCase()).toContain('agent is still working')
})

