import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, dragTo, type LaunchedApp } from './helpers'

/** Angel: "tabs in the browser cannot sort". They open in the order they were
 *  created and could not be moved. */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

const titles = async (page: LaunchedApp['page']): Promise<string[]> =>
  page.locator('.browser-tab-title').allTextContents()

test('a browser tab can be dragged into a different position', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await page.locator('.tile-tabs button', { hasText: /^Browser$/ }).first().click()
  await expect(page.locator('.browser-pane')).toBeVisible()

  // three tabs, each named by its url so the order is readable
  for (const host of ['example.com', 'example.org', 'example.net']) {
    await page.locator('.browser-tab-add').click()
    await page.locator('.browser-url').fill(host)
    await page.locator('.browser-url').press('Enter')
  }
  const before = await titles(page)
  expect(before.length).toBeGreaterThanOrEqual(3)

  // drag the LAST tab onto the first position
  await dragTo(page, '.browser-tab:last-of-type', '.browser-tab:first-of-type', 'center')

  await expect
    .poll(async () => (await titles(page))[0], { timeout: 10_000 })
    .toBe(before[before.length - 1])
})
