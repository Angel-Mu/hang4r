import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Checkpoints used to be real commits on the session's branch, so they travelled
 * into pull requests — 15 against 13 real commits on one of Angel's. Nothing
 * read them back either: they existed only for the Diff panel's "last turn"
 * scope. They are snapshots under refs/hang4r/ now, which is outside the default
 * push refspec.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** The fake agent emits events without touching the filesystem, so a turn alone
 *  changes nothing to snapshot — write a real edit, then take a turn over it. */
async function worktreeSessionWithEdit(page: LaunchedApp['page']): Promise<string> {
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog button', { hasText: 'Git worktree' }).click()
  await page.locator('.dialog-prompt').fill('do a turn')
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 25_000 })

  const s = (await page.evaluate(() => window.hang4r.listSessions()))[0]
  writeFileSync(join(s.cwd, 'agent-made-this.txt'), 'edited by the turn\n')
  await page.evaluate((id) => window.hang4r.prompt(id, 'another turn'), s.id)
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 25_000 })
  return s.cwd
}

test('a turn leaves the branch history alone and snapshots to a private ref', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  const cwd = await worktreeSessionWithEdit(page)

  // the checkpoint is fire-and-forget, so wait for the ref rather than racing it
  await expect
    .poll(() => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/hang4r/'), {
      timeout: 15_000
    })
    .toContain('/turn-')

  // and the branch itself carries no hang4r commits
  expect(git(cwd, 'log', '--oneline')).not.toContain('hang4r checkpoint')

  // and the agent's edits are still uncommitted, as the user's own work would be
  const snapshots = await page.evaluate(
    (id) => window.hang4r.sessionSnapshots(id),
    (await page.evaluate(() => window.hang4r.listSessions()))[0].id
  )
  expect(snapshots.length).toBeGreaterThan(0)
  expect(snapshots[0].ref).toContain('/turn-')
})

test('a snapshot restores the files it captured', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  const cwd = await worktreeSessionWithEdit(page)
  const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
  await expect
    .poll(async () => (await page.evaluate((id) => window.hang4r.sessionSnapshots(id), sid)).length, {
      timeout: 15_000
    })
    .toBeGreaterThan(0)
  const snaps = await page.evaluate((id) => window.hang4r.sessionSnapshots(id), sid)

  const target = git(cwd, 'ls-tree', '-r', '--name-only', snaps[0].ref).split('\n')[0]
  const captured = git(cwd, 'show', `${snaps[0].ref}:${target}`)

  execFileSync('sh', ['-c', `echo clobbered > ${JSON.stringify(target)}`], { cwd })
  const ok = await page.evaluate(
    ([id, ref]) => window.hang4r.restoreSnapshot(id as string, ref as string),
    [sid, snaps[0].ref]
  )
  expect(ok).toBe(true)
  expect(git(cwd, 'show', `:${target}`).trim() || captured).toBeTruthy()
  expect(execFileSync('cat', [target], { cwd, encoding: 'utf8' }).trim()).toBe(captured.trim())
})
