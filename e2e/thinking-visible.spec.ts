import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * A thought with no words used to render as a token count, which is why this
 * asserts an absence.
 */
test('a thought with no text draws nothing at all', async () => {
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

  // the fake agent sends its reasoning intact, so every block drawn is a toggle
  const blocks = tile.locator('.thinking-block')
  for (let i = 0; i < (await blocks.count()); i++) {
    await expect(blocks.nth(i).locator('.thinking-toggle')).toBeVisible()
  }
  await expect(tile.locator('.thinking-redacted')).toHaveCount(0)
})

/**
 * The API's thinking display default is "omitted" on the 5-series models, so
 * without this flag every thinking block streams empty.
 */
test('the claude adapter asks the CLI for readable reasoning', () => {
  const bundle = readFileSync(join(process.cwd(), 'out/main/index.js'), 'utf8')
  expect(bundle).toContain('--thinking-display')
  expect(bundle).toContain('summarized')
})
