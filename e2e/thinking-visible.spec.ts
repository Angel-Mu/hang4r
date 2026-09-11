import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "we are not showing the 'thinking' text of the agent … we should
 * display it similarly to cursor".
 *
 * It was rendered, but folded into the "Worked N steps" group AND collapsed
 * behind its own toggle inside that — two closed doors, so it was never seen.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('reasoning shows in the conversation without opening anything', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('think about it')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // present in the conversation with no clicks, and NOT nested inside the
  // collapsed activity group — the body itself stays folded until asked for
  const thinking = tile.locator('.thinking-block')
  await expect(thinking.first()).toBeVisible()
  await expect(thinking.first().locator('.thinking-peek')).toBeVisible()
  expect(await tile.locator('.activity-body .thinking-block').count()).toBe(0)
})

/**
 * Angel: "is not expandable anymore, only can see the thought - ~X token".
 *
 * Both forms exist and only one is a control: a thought whose words arrived
 * expands, a redacted one reports its length. They shared a class, so the
 * redacted form read as a toggle that did nothing.
 */
test('a redacted thought is plainly not a toggle', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('think about it')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  await expect(tile.locator('.thinking-block').first()).toBeVisible({ timeout: 20_000 })

  // the fake agent sends its reasoning intact, so this one IS a toggle
  const expandable = tile.locator('.thinking-block', { has: page.locator('.thinking-peek') }).first()
  await expect(expandable.locator('.thinking-toggle')).toBeVisible()
  await expect(expandable.locator('.thinking-redacted')).toHaveCount(0)

  // and a redacted one carries no toggle at all
  const redacted = tile.locator('.thinking-block', { has: page.locator('.thinking-redacted') })
  if ((await redacted.count()) > 0) {
    await expect(redacted.first().locator('.thinking-toggle')).toHaveCount(0)
    await expect(redacted.first()).toContainText('hidden by the CLI')
  }
})
