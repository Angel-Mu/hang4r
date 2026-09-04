import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "when splitting editor we cannot search on the file I'm focused in,
 * only on one of them".
 *
 * ⌘F picked the first VISIBLE editor in the focused tile. With a split there are
 * several, and the first is not the one you are in.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('⌘F opens find in the split pane you are focused in', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await tile.locator('.tile-tabs button', { hasText: /^Files$/ }).first().click()
  await tile.locator('.file-row', { hasText: 'README.md' }).click()
  await expect(tile.locator('.code-editor')).toHaveCount(1)

  // split, which leaves two editors visible side by side
  await tile.locator('.editor-slot:visible .code-editor-preview').first().click()
  await page.keyboard.press('Meta+Backslash')
  await expect(tile.locator('.code-editor')).toHaveCount(2)

  // focus the SECOND pane, then ask for find
  const second = tile.locator('.code-editor').nth(1)
  await second.click()
  await page.keyboard.press('Meta+KeyF')

  await expect(second.locator('.chat-find-bar')).toBeVisible({ timeout: 10_000 })
  expect(await tile.locator('.code-editor').nth(0).locator('.chat-find-bar').count()).toBe(0)
})
