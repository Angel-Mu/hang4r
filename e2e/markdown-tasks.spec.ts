import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "review what's going on with tasks it looks like hang4r never create
 * them… I need it as tasks that can render here at Hang4r."
 *
 * TaskCreate/TaskUpdate were retired from the CLI around 2026-08-14 — his store
 * has not recorded one since, and no current session lists them. The agent still
 * writes the board as markdown, so that is what the panel reads.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a markdown checklist becomes the task board', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('write a checklist')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // the strip above the composer counts it
  const strip = tile.locator('.task-progress')
  await expect(strip).toBeVisible({ timeout: 10_000 })
  await expect(strip.locator('.task-progress-count')).toContainText('Tasks 2/4')

  // and the panel lists the items
  await strip.click()
  await expect(tile.locator('.context-panel')).toContainText('Approval API', { timeout: 10_000 })
})
