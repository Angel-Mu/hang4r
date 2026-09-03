import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "I can see the subagent is running, I can see the session is still
 * working but I'm not able to see that something is working behind the scenes."
 *
 * The pending footer only speaks after a turn ENDS — it exists to stop "done"
 * being the last word. While a turn is live it said nothing, so a running
 * subagent appeared in the panel and nowhere in the conversation.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a running subagent is named while the turn is still live', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('agents still working')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  const badge = tile.locator('.chat-working-runs')
  await expect(badge).toContainText(/agent(s)? working/, { timeout: 15_000 })

  // it opens the panel that has the detail, rather than being a dead label
  await badge.click()
  await expect(tile.locator('.subagent-run').first()).toBeVisible({ timeout: 10_000 })
})

test('thoughts start collapsed and open on click', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('think about it')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  const block = tile.locator('.thinking-block').first()
  await expect(block).toBeVisible({ timeout: 20_000 })

  // collapsed: a one-line summary, no quoted body and so no left rule
  await expect(block.locator('.thinking-peek')).toBeVisible()
  await expect(block.locator('.thinking-text')).toHaveCount(0)

  await block.locator('.thinking-peek').click()
  await expect(block.locator('.thinking-text')).toBeVisible()
})
