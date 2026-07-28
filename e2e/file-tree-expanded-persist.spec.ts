import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Expanded folders in the Files tree must survive a panel switch. The context
 * panels are conditionally rendered, so leaving Files unmounts the tree — its
 * expanded state used to reset to all-collapsed on return (Angel: "I expand
 * folders, switch to another panel, come back, everything's collapsed"). The
 * expanded set is now kept in a sessionId-keyed memo like the panel's other
 * state, so it's restored on remount.
 */
test('file tree keeps expanded folders across a panel switch', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('tree persist test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Files → expand the 'src' folder so its child index.js shows
    await tile.getByRole('button', { name: 'Files' }).click()
    const srcRow = tile.locator('.file-row', { hasText: 'src' })
    await expect(srcRow).toBeVisible({ timeout: 15_000 })
    await srcRow.click()
    await expect(tile.locator('.file-row', { hasText: 'index.js' })).toBeVisible({ timeout: 5_000 })

    // switch away (Tasks) — the Files tree unmounts…
    await tile.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(tile.locator('.file-row', { hasText: 'src' })).toHaveCount(0)

    // …back to Files → 'src' is STILL expanded (index.js visible), not reset
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.file-row', { hasText: 'index.js' })).toBeVisible({ timeout: 5_000 })
  } finally {
    await launched.app.close()
  }
})
