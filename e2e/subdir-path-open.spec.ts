import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Clicking a path that lives in a subdir opens it in the EDITOR (resolved to its
 * real in-tree location), NOT a preview modal. Regression for Angel's infinite
 * loop: previously such a path opened a blank editor tab that failed to read and
 * re-opened the preview overlay on every panel switch. Opening in the editor with
 * NO modal means there is nothing to re-open.
 */
test('a subdir path opens in the editor, not a re-opening preview modal', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('subdir open test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // write a file into a subdir of the session's actual cwd (a worktree)
    const cwd = await page.evaluate(async () => (await window.hang4r.listSessions())[0].cwd)
    const rel = 'subdir/deepnote.json'
    mkdirSync(join(cwd, 'subdir'), { recursive: true })
    writeFileSync(join(cwd, rel), '{ "marker": "SUBDIR_OPEN_ok" }\n')

    // a fenced message renders as markdown → the inline `subdir/deepnote.json`
    // (has a slash → file-like) becomes a ⌘-clickable code-link
    await tile
      .locator('.composer-input')
      .fill(`open \`${rel}\` please\n\n\`\`\`\nnoop\n\`\`\``)
    await tile.getByRole('button', { name: 'Send' }).click()

    const link = tile.locator('.code-link', { hasText: rel }).first()
    await expect(link).toBeVisible({ timeout: 10_000 })
    await link.click({ modifiers: ['Meta'] })

    // it opened in the EDITOR (resolved), and NO preview modal appeared
    await expect(tile.locator('.editor-slot:visible .code-editor-path')).toContainText(
      'deepnote.json',
      { timeout: 10_000 }
    )
    await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  } finally {
    await launched.app.close()
  }
})
