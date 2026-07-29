import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * File paths in tool calls (Read/Write/Edit …) are clickable — open the file in
 * the editor for a workspace path, or a preview for an out-of-tree path like a
 * /tmp file a run wrote (Angel: let me cmd-click a session's file paths open).
 */
test('a tool-call file path is clickable and opens the file in the editor', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('tool path test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // the fake turn's Write tool wrote hang4r-fake-1.txt — expand any COLLAPSED
    // activity groups (the tail one is already open) so its tool row is visible
    for (let i = 0; i < 6; i++) {
      const collapsed = tile.locator('.activity-header', { hasText: '▸' })
      if ((await collapsed.count()) === 0) break
      await collapsed.first().click()
    }

    const link = tile.locator('.tool-path-link', { hasText: 'hang4r-fake-1.txt' }).first()
    await expect(link).toBeVisible({ timeout: 10_000 })

    // click the path → opens it in the editor (switches to Files, shows the file)
    await link.click()
    await expect(tile.locator('.editor-slot:visible .code-editor-path')).toContainText(
      'hang4r-fake-1.txt',
      { timeout: 10_000 }
    )
  } finally {
    await launched.app.close()
  }
})
