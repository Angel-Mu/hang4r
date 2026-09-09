import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, dragTo, type LaunchedApp } from './helpers'

/**
 * Angel: "from the file IDE, we should be able to drag and drop files/folder
 * into the input for the conversation right now only works with files."
 *
 * Folder rows were not draggable at all. A folder attaches as a PATH, not as its
 * contents — reading a directory in is how one of his sessions accumulated 463
 * attachments.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a folder can be dragged into the composer and attaches as a path', async () => {
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
  const folder = tile.locator('.file-row[data-path="src"]')
  await expect(folder).toBeVisible({ timeout: 10_000 })
  await expect(folder).toHaveAttribute('draggable', 'true')

  await dragTo(page, '.file-row[data-path="src"]', '.composer', 'center')

  const chip = tile.locator('.composer-chips .context-chip').first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await expect(chip).toHaveClass(/context-chip-dir/)
  await expect(chip.locator('.chip-badge')).toHaveText('DIR')
  // the path, not the directory's contents
  await expect(chip).toContainText('src/')
})
