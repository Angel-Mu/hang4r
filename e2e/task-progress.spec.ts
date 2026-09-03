import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel, pointing at Hermes: "check how the tasks are being displayed at every
 * moment, telling us where the agent is progressing". hang4r reconstructed the
 * list already, but only inside a side panel you had to open.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('the agent task list shows its progress above the composer', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('plan some work')
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  const strip = tile.locator('.task-progress')
  await expect(strip).toBeVisible({ timeout: 10_000 })
  await expect(strip.locator('.task-progress-count')).toContainText(/Tasks \d+\/\d+/)

  // it is the way into the panel, not a dead label
  await strip.click()
  await expect(tile.locator('.bgtask-panel, .tasks-panel, .context-panel')).toBeVisible({
    timeout: 10_000
  })
})
