import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * In-file find & REPLACE (Angel's IDE-capabilities batch). The editor find bar
 * gained a collapsible replace row (Monaco model edits) — find-only scopes
 * (chat/terminal/browser) are unaffected. README.md contains "scratch".
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('replace all swaps every match and empties the count', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo() // README.md is "# scratch\n"
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('replace')
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await tile.getByRole('button', { name: 'Files' }).click()
  await tile.locator('.file-row[data-path="README.md"]').click()
  await tile.locator('.preview-source-tab', { hasText: 'Source' }).click()
  const editor = tile.locator('.editor-slot:visible .monaco-editor')
  await expect(editor).toBeVisible()
  await editor.click()

  // find "scratch" → 1 match
  await page.keyboard.press('Meta+f')
  const findInput = tile.locator('[placeholder="Find in file"]')
  await expect(findInput).toBeVisible()
  await findInput.fill('scratch')
  await expect(tile.locator('.chat-find-count')).toHaveText('1/1')

  // reveal replace, swap "scratch" → "xyz", Replace All
  await tile.locator('.editor-replace-toggle').click()
  const replaceInput = tile.locator('.editor-replace-bar [placeholder="Replace"]')
  await expect(replaceInput).toBeVisible()
  await replaceInput.fill('xyz')
  await tile.locator('.editor-replace-act', { hasText: 'All' }).click()

  // the query no longer matches, and the editor shows the replacement
  await expect(tile.locator('.chat-find-count')).toHaveText('0/0')
  await expect(editor).toContainText('xyz')
  await expect(editor).not.toContainText('scratch')
})
