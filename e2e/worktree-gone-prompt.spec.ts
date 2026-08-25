import { test, expect } from '@playwright/test'
import { rmSync, existsSync } from 'node:fs'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: after a merge-cleanup removes the worktree, the next prompt silently
 * rebuilt it and re-ran the whole setup script — even when the question only
 * needed what was already in the conversation.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

/** A worktree session that has finished a turn, with its worktree then removed
 *  from disk the way `wt remove` / merge-cleanup leaves it. */
async function sessionWithRemovedWorktree(
  page: LaunchedApp['page'],
  repo: string
): Promise<{ id: string; cwd: string }> {
  const project = await createProject(page, repo)
  const s = await page.evaluate(
    (pid) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'worktree',
        permissionMode: 'default',
        title: 'wt-gone',
        firstPrompt: 'first turn'
      }),
    project.id
  )
  await expect
    .poll(() => page.evaluate(() => window.hang4r.listSessions().then((l) => l[0]?.status)), {
      timeout: 20_000
    })
    .toBe('idle')
  rmSync(s.cwd, { recursive: true, force: true })
  expect(existsSync(s.cwd)).toBe(false)
  return { id: s.id, cwd: s.cwd }
}

test('a prompt on a cleaned-up worktree asks instead of rebuilding', async () => {
  launched = await launchApp()
  const { page } = launched
  const { id, cwd } = await sessionWithRemovedWorktree(page, makeScratchRepo())

  void page.evaluate((sid) => window.hang4r.prompt(sid, 'what did we decide?'), id)

  const dialog = page.locator('.wt-dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog.locator('.quit-title')).toContainText('wt-gone')

  // answering from the conversation must NOT put the worktree back
  await dialog.getByRole('button', { name: /Answer from the conversation/ }).click()
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(1500)
  expect(existsSync(cwd)).toBe(false)
})

test('choosing Rebuild puts the worktree back, and the choice is not re-asked', async () => {
  launched = await launchApp()
  const { page } = launched
  const { id, cwd } = await sessionWithRemovedWorktree(page, makeScratchRepo())

  void page.evaluate((sid) => window.hang4r.prompt(sid, 'keep working'), id)
  await expect(page.locator('.wt-dialog')).toBeVisible({ timeout: 15_000 })
  await page.locator('.wt-dialog .wt-rebuild').click()

  await expect.poll(() => existsSync(cwd), { timeout: 20_000 }).toBe(true)
  await expect(page.locator('.wt-dialog')).toBeHidden()
})

test('Esc cancels the prompt outright — no rebuild, no turn', async () => {
  launched = await launchApp()
  const { page } = launched
  const { id, cwd } = await sessionWithRemovedWorktree(page, makeScratchRepo())

  void page.evaluate((sid) => window.hang4r.prompt(sid, 'never mind'), id)
  await expect(page.locator('.wt-dialog')).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.wt-dialog')).toBeHidden()

  await page.waitForTimeout(1200)
  expect(existsSync(cwd)).toBe(false)
  const status = await page.evaluate(() => window.hang4r.listSessions().then((l) => l[0]?.status))
  expect(status).toBe('idle')
})

test('an intact worktree never asks', async () => {
  launched = await launchApp()
  const { page } = launched
  const project = await createProject(page, makeScratchRepo())
  const s = await page.evaluate(
    (pid) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'worktree',
        permissionMode: 'default',
        title: 'wt-intact',
        firstPrompt: 'first turn'
      }),
    project.id
  )
  await expect
    .poll(() => page.evaluate(() => window.hang4r.listSessions().then((l) => l[0]?.status)), {
      timeout: 20_000
    })
    .toBe('idle')

  void page.evaluate((sid) => window.hang4r.prompt(sid, 'second turn'), s.id)
  await page.waitForTimeout(1500)
  await expect(page.locator('.wt-dialog')).toHaveCount(0)
})
