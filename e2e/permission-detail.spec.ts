import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A permission (Allow/Deny) card must show the FULL command, not a truncated
 * preview — you're approving a command and need to read all of it before you
 * decide (Angel: couldn't fully expand what the command was). The one-line
 * summary is a preview; the detail carries the whole command, wrapped/scrollable.
 */
test('the permission card shows the full command in its detail', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('ask permission to start')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    const card = tile.locator('.permission-card')
    await expect(card).toBeVisible({ timeout: 15_000 })

    // the FULL command is readable in the detail — including the part the header
    // summary truncated away
    const detail = card.locator('.permission-detail')
    await expect(detail).toContainText('FULLCMD_MARKER_qz')
    await expect(detail).toContainText('the whole command must be readable')
  } finally {
    await launched.app.close()
  }
})
