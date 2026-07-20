import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Unified find bar (round 13 ①), EDITOR scope: ⌘F while Monaco has focus opens
 * OUR bar (the same `.chat-find-bar` chrome as chat), NOT Monaco's built-in
 * `.find-widget`, and drives Monaco's search APIs (findMatches + decorations +
 * reveal).
 */
test.describe('find bar — editor scope', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('⌘F over Monaco opens our bar (not Monaco’s), counts + navigates matches, Esc returns focus', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    // a committed file with a term repeated on four separate lines
    writeFileSync(join(repo, 'haystack.js'), 'const needle = 1\n// needle\n// needle\n// needle\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'haystack'], { cwd: repo })

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('open a file')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // open the Files panel and load the file into the Monaco editor
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()
    await tile.locator('.file-row', { hasText: 'haystack.js' }).click()
    const editor = tile.locator('.editor-slot:visible .monaco-editor')
    await expect(editor).toBeVisible()
    await editor.click()

    // ⌘F → OUR bar, auto-focused; Monaco's own find widget must NOT appear
    await page.keyboard.press('Meta+F')
    const bar = tile.locator('.chat-find-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.chat-find-input')).toBeFocused()
    await expect(editor.locator('.find-widget')).toHaveCount(0)

    await bar.locator('.chat-find-input').fill('needle')
    // four matches in the file
    await expect(bar.locator('.chat-find-count')).toHaveText(/\/4$/)
    // decorations painted: the current match carries our accent class
    await expect(editor.locator('.hang4r-find-match-current')).toHaveCount(1)
    await expect(editor.locator('.hang4r-find-match').first()).toBeVisible()

    // Enter advances (the active index in "n/4" changes)
    const before = await bar.locator('.chat-find-count').textContent()
    await bar.locator('.chat-find-input').press('Enter')
    await expect(bar.locator('.chat-find-count')).not.toHaveText(before ?? '')
    await expect(bar.locator('.chat-find-count')).toHaveText(/\/4$/)

    // Esc closes the bar and returns focus to the editor
    await bar.locator('.chat-find-input').press('Escape')
    await expect(bar).toHaveCount(0)
    // focus returned to the editor — Monaco flags its focused container with a
    // `.focused` class (its real input textarea's class varies by build)
    await expect(editor).toHaveClass(/focused/)
  })
})
