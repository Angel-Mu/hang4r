import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * "Reveal in Finder" — for files hang4r can't display usefully (a binary that
 * opens as garbled bytes), let the user jump to the file in the OS file manager,
 * from BOTH the file explorer's context menu and the editor (Angel). We don't
 * actually click it (that would spawn Finder in CI) — we assert the affordances
 * exist and the API is wired.
 */
test('Reveal in Finder is offered from the file explorer and the editor', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('reveal test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // the IPC is wired on the bridge
    expect(await page.evaluate(() => typeof window.hang4r.revealInFinder)).toBe('function')

    await tile.getByRole('button', { name: 'Files' }).click()
    const readmeRow = tile.locator('.file-row', { hasText: 'README.md' })
    await expect(readmeRow).toBeVisible({ timeout: 15_000 })

    // file-explorer context menu offers Reveal in Finder
    await readmeRow.click({ button: 'right' })
    await expect(page.locator('.ctx-item', { hasText: 'Reveal in Finder' })).toBeVisible()
    await page.keyboard.press('Escape')

    // opening the file → the editor bar offers Reveal in Finder too (the IDE side)
    await readmeRow.click()
    await expect(tile.locator('.editor-slot:visible .code-editor-path')).toContainText('README.md')
    await expect(tile.locator('.editor-slot:visible .code-editor-reveal')).toHaveText('Reveal in Finder')
  } finally {
    await launched.app.close()
  }
})
