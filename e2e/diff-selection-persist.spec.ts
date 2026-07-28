import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The Diff panel must keep which file you're reviewing when you switch panels.
 * Context panels are conditionally rendered, so leaving Diff unmounts it and its
 * local `selected` (+ view toggles) used to reset — you'd come back to the first
 * file, losing your place mid-review (Angel: state-loss across panels). The Diff
 * UI state is now kept in a sessionId-keyed memo like the file tree's.
 */
test('Diff panel keeps the selected file across a panel switch', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('diff persist test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Diff panel → the fake turn produced several changed files
    await tile.getByRole('button', { name: 'Diff', exact: true }).click()
    const rows = tile.locator('.diff-file-row')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
    const count = await rows.count()
    expect(count).toBeGreaterThan(1) // need a non-default file to prove persistence

    // select the LAST file (not the auto-selected first) and note its path
    await rows.nth(count - 1).click()
    await expect(rows.nth(count - 1)).toHaveClass(/diff-file-row-active/)
    const chosen = (await tile.locator('.diff-toolbar-path').textContent())?.trim()
    expect(chosen).toBeTruthy()

    // switch away (Files) — Diff unmounts — then back
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.diff-file-row')).toHaveCount(0)
    await tile.getByRole('button', { name: 'Diff', exact: true }).click()

    // the SAME file is still selected — not reset to the first
    await expect(tile.locator('.diff-toolbar-path')).toHaveText(chosen!, { timeout: 10_000 })
    await expect(tile.locator('.diff-file-row-active')).toHaveCount(1)
  } finally {
    await launched.app.close()
  }
})
