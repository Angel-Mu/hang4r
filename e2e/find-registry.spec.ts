import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Find bars are INDEPENDENT per scope (Angel: "every search on its own scope").
 * The chat bar lives in the always-visible chat-panel; the editor bar in the
 * context-panel — SIBLING panes in the same tile. Opening the editor find must
 * NOT close the conversation's find: both stay open and searchable at once.
 * (Reversal of the old single-bar QA hunt #11 — see src/renderer/src/findRegistry.ts.)
 */
test.describe('find bar — independent per scope', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('opening find in a file leaves the conversation find open (independent scopes)', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    writeFileSync(join(repo, 'haystack.js'), 'const needle = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'haystack'], { cwd: repo })

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.evaluate(() => window.hang4r.setSetting('terminalShell', '/bin/bash'))
    await expect(page.locator('.project-name')).toHaveText(basename(repo))

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('find registry test')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // 1) ⌘F in chat opens the chat-scoped bar
    await page.keyboard.press('Meta+F')
    const bars = page.locator('.chat-find-bar')
    await expect(bars).toHaveCount(1)
    await expect(bars.first().locator('.chat-find-input')).toHaveAttribute(
      'placeholder',
      'Find in conversation'
    )

    // 2) click into Monaco, ⌘F again — the editor bar opens in the sibling pane.
    // The conversation bar must STAY OPEN: two independent scopes, two bars.
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()
    await tile.locator('.file-row', { hasText: 'haystack.js' }).click()
    const editor = tile.locator('.editor-slot:visible .monaco-editor')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press('Meta+F')

    await expect(bars).toHaveCount(2)
    const placeholders = await bars.locator('.chat-find-input').evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement).placeholder)
    )
    expect(placeholders).toContain('Find in conversation')
    expect(placeholders).toContain('Find in file')
  })
})
