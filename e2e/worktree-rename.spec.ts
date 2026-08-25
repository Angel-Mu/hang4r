import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "when renaming the session is it possible to rename the worktree?
 * (only for those which started as a worktree)".
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

const branches = (repo: string): string =>
  execFileSync('git', ['branch', '--list'], { cwd: repo }).toString()

async function worktreeSession(
  page: LaunchedApp['page'],
  repo: string,
  title: string
): Promise<{ id: string; cwd: string }> {
  const project = await createProject(page, repo)
  const s = await page.evaluate(
    ({ pid, t }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'worktree',
        permissionMode: 'default',
        title: t
      }),
    { pid: project.id, t: title }
  )
  return { id: s.id, cwd: s.cwd }
}

test('renaming a worktree session renames its folder and its branch', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const { id, cwd } = await worktreeSession(page, repo, 'old name')
  expect(existsSync(cwd)).toBe(true)
  expect(branches(repo)).toContain(basename(cwd))

  const moved = await page.evaluate(
    (sid) => window.hang4r.renameSession(sid, 'shiny new name'),
    id
  )
  expect(moved).toBeTruthy()
  expect(basename(moved as string)).toBe('shiny-new-name')

  // the folder really moved, and the branch followed it
  expect(existsSync(cwd)).toBe(false)
  expect(existsSync(moved as string)).toBe(true)
  expect(branches(repo)).toContain('shiny-new-name')
  expect(branches(repo)).not.toContain(basename(cwd))

  // and the session now points at the new directory
  const after = await page.evaluate(() => window.hang4r.listSessions())
  expect(after[0].cwd).toBe(moved)
  expect(after[0].title).toBe('shiny new name')
})

test('an in-place session renames its title only — there is no worktree to move', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  const s = await page.evaluate(
    (pid) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'in place'
      }),
    project.id
  )

  const moved = await page.evaluate((sid) => window.hang4r.renameSession(sid, 'renamed'), s.id)
  expect(moved).toBeNull()
  const after = await page.evaluate(() => window.hang4r.listSessions())
  expect(after[0].title).toBe('renamed')
  expect(after[0].cwd).toBe(s.cwd) // still the project root
})

test('a working agent keeps its worktree — the rename takes the title only', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')

  // this prompt parks the turn, so the session stays 'running' while we rename
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('ask permission to do a thing')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible({ timeout: 15_000 })

  const before = (await page.evaluate(() => window.hang4r.listSessions()))[0]
  const moved = await page.evaluate(
    (sid) => window.hang4r.renameSession(sid, 'renamed mid turn'),
    before.id
  )
  expect(moved).toBeNull()

  const after = (await page.evaluate(() => window.hang4r.listSessions()))[0]
  expect(after.title).toBe('renamed mid turn')
  expect(after.cwd).toBe(before.cwd) // the agent's directory was not moved
  expect(existsSync(before.cwd)).toBe(true)
})
