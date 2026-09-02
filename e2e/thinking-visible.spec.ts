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

  // visible with no clicks, and NOT nested inside the collapsed activity group
  const thinking = tile.locator('.thinking-block')
  await expect(thinking.first()).toBeVisible()
  await expect(thinking.first().locator('.thinking-text')).toBeVisible()
  expect(await tile.locator('.activity-body .thinking-block').count()).toBe(0)
})
