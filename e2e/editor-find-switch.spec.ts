import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * ⌘F must open the find bar of the file you're LOOKING at. With several files
 * open, switching to another one and pressing ⌘F used to open (or re-open) the
 * find bar on the FIRST file — hidden behind the active one — so it "did nothing"
 * (Angel). Fix: focus follows the active tab, and ⌘F routes to the visible editor.
 */
test.describe('editor find — follows the active file', () => {
  let launched: LaunchedApp
  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('after switching files, ⌘F opens the VISIBLE file’s find bar', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    writeFileSync(join(repo, 'aa.js'), 'const alpha = 1\n// alpha\n// alpha\nconst a2 = alpha\n')
    writeFileSync(join(repo, 'bb.js'), 'const beta = 2\n// beta\n// beta\nconst b2 = beta\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'ab'], { cwd: repo })

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('find switch')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()

    // open aa.js, find in it
    await tile.locator('.file-row', { hasText: 'aa.js' }).click()
    await expect(tile.locator('.editor-slot:visible .monaco-editor')).toContainText('alpha')
    await page.keyboard.press('Meta+F')
    let bar = tile.locator('.editor-slot:visible .chat-find-bar')
    await expect(bar).toBeVisible()
    await bar.locator('.chat-find-input').fill('alpha')
    await expect(tile.locator('.editor-slot:visible .hang4r-find-match').first()).toBeVisible()
    await bar.locator('.chat-find-input').press('Escape')

    // switch to bb.js — WITHOUT clicking into its editor — then ⌘F
    await tile.locator('.file-row', { hasText: 'bb.js' }).click()
    await expect(tile.locator('.editor-slot:visible .monaco-editor')).toContainText('beta')
    await page.keyboard.press('Meta+F')
    bar = tile.locator('.editor-slot:visible .chat-find-bar')
    // THE regression: the visible (bb.js) file's find bar opens — not aa.js's hidden one
    await expect(bar).toBeVisible()
    await bar.locator('.chat-find-input').fill('beta')
    await expect(tile.locator('.editor-slot:visible .hang4r-find-match').first()).toBeVisible()
  })
})
