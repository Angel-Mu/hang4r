import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

/** Angel: "the prompt for a new agent closes easily and sometimes we lost the
 *  progress when there was already some message". */
test('a written new-agent prompt survives closing the dialog', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('a prompt I do not want to lose')
  await page.keyboard.press('Escape')
  await expect(page.locator('.dialog')).toHaveCount(0)

  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await expect(page.locator('.dialog-prompt')).toHaveValue('a prompt I do not want to lose')
})

test('a backdrop click does not discard a written prompt', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('still typing')
  await page.locator('.dialog-backdrop').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.dialog')).toBeVisible() // stayed open

  // with nothing written it closes as before
  await page.locator('.dialog-prompt').fill('')
  await page.locator('.dialog-backdrop').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.dialog')).toHaveCount(0)
})

/** Angel: an in-place session had no way to be named. */
test('an in-place session can be named without making a worktree', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog button', { hasText: 'In-place' }).click()
  await expect(page.locator('.dialog .field-label', { hasText: 'Session name' })).toBeVisible()

  await page.locator('.dialog input.field[type="text"], .dialog input.field:not([type])').first().fill('named-in-place')
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.session-row', { hasText: 'named-in-place' })).toBeVisible({
    timeout: 20_000
  })
})

/**
 * Angel: "I noticed a rename does not rename the worktree".
 *
 * The move cannot happen under a live CLI — the cwd would go out from under it —
 * so a rename mid-turn skipped the worktree and said nothing. It is deferred to
 * the end of the turn now.
 */
test('a rename during a turn still moves the worktree once the turn ends', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')

  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog button', { hasText: 'Git worktree' }).click()
  await page.locator('.dialog-prompt').fill('ask permission to do a thing') // parks mid-turn
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible({ timeout: 20_000 })

  const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
  const before = (await page.evaluate(() => window.hang4r.listSessions()))[0].cwd
  await page.evaluate((id) => window.hang4r.renameSession(id, 'renamed-mid-turn'), sid)

  // still parked: the worktree cannot move yet
  expect((await page.evaluate(() => window.hang4r.listSessions()))[0].cwd).toBe(before)

  // let the turn finish, then the deferred move runs
  await page.locator('.tile .permission-card button', { hasText: /^Allow$/ }).first().click()
  await expect
    .poll(async () => (await page.evaluate(() => window.hang4r.listSessions()))[0].cwd, {
      timeout: 20_000
    })
    .toContain('renamed-mid-turn')
})
