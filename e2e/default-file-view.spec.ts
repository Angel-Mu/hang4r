import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "I usually like to read the md files in preview mode, and I always have
 * to change the view mode manually." Previewable files now OPEN rendered, and
 * Settings → General flips that back to Source for anyone who wants it.
 */
test.describe('default file view', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  const openFiles = async (page: LaunchedApp['page'], repo: string): Promise<void> => {
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
    await expect(page.locator('.dialog')).toBeHidden()
    const tile = page.locator('.tile').first()
    await tile.locator('.status-dot.status-idle').first().waitFor({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Files' }).click()
  }

  test('markdown opens rendered, and the per-doc choice outlives a tab switch', async () => {
    launched = await launchApp()
    const { page } = launched
    const tile = page.locator('.tile').first()
    await openFiles(page, makeScratchRepo())

    await tile.locator('.file-row', { hasText: 'docs.md' }).click()
    await expect(tile.locator('.code-editor-preview h1', { hasText: 'Docs Title' })).toBeVisible({
      timeout: 10_000
    })

    // an explicit Source choice must beat the setting, and survive leaving the tab
    await tile.locator('.preview-source-tab', { hasText: 'Source' }).click()
    await expect(tile.locator('.editor-slot:visible .monaco-editor')).toBeVisible()
    await tile.locator('.file-row', { hasText: 'README.md' }).click()
    await expect(tile.locator('.code-editor-preview h1', { hasText: 'scratch' })).toBeVisible({
      timeout: 10_000
    })
    await tile.locator('.editor-tab', { hasText: 'docs.md' }).click()
    await expect(tile.locator('.editor-slot:visible .monaco-editor')).toBeVisible()
  })

  test('defaultFileView: source opens markdown in the editor instead', async () => {
    launched = await launchApp()
    const { page, userDataDir } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    writeFileSync(
      join(userDataDir, '.hang4r', 'settings.json'),
      JSON.stringify({ defaultFileView: 'source' }, null, 2)
    )
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
    await expect(page.locator('.dialog')).toBeHidden()
    const tile = page.locator('.tile').first()
    await tile.locator('.status-dot.status-idle').first().waitFor({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Files' }).click()

    await tile.locator('.file-row', { hasText: 'docs.md' }).click()
    await expect(tile.locator('.editor-slot:visible .monaco-editor')).toBeVisible({ timeout: 10_000 })
    await expect(tile.locator('.code-editor-preview')).toHaveCount(0)
  })
})
