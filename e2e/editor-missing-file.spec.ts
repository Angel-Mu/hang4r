import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A persisted editor tab whose file is GONE (e.g. a removed worktree restored on
 * relaunch) used to pop a blocking "Couldn't open … for preview" modal — Angel
 * kept hitting it at random, even right after reopening the app. The editor must
 * now show a quiet inline notice and NO modal for a missing file. (A USER click
 * on an out-of-tree path still gets the modal — that path isn't exercised here.)
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('opening a missing file shows a quiet inline notice, not a blocking preview modal', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('missing file')
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // simulate the restore of a tab whose file no longer exists on disk
  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __hang4r_store: {
          getState(): { focusedSessionId: string; requestOpenFile(id: string, path: string): void }
        }
      }
    ).__hang4r_store.getState()
    s.requestOpenFile(s.focusedSessionId, 'gone/removed-worktree-file.md')
  })

  // quiet inline notice appears...
  await expect(tile.getByText(/couldn.t open — file may have moved/i)).toBeVisible({ timeout: 10_000 })
  // ...and NO blocking preview modal
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
})
