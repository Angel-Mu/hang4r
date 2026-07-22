import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Regression for the ⌘P-opened-file editor break (Angel): a file opened through
 * the ⌘P quick-finder never received focus, so ⌘F routed to the chat find bar
 * (App.tsx only lets Monaco keep ⌘F when a `.monaco-editor` is focused) and
 * ⌘-click go-to-definition needed a throwaway focus-click first. NOTE: these
 * tests never click the editor — the whole point is that opening must focus it.
 */
test.describe('editor — ⌘P open focuses the editor', () => {
  let launched: LaunchedApp
  test.afterEach(async () => {
    await launched?.app.close()
  })

  const startSession = async (page: LaunchedApp['page'], repo: string): Promise<void> => {
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('open via cmd-p')
    await page.getByRole('button', { name: /Start agent/ }).click()
  }

  test('a ⌘P-opened file is focused — ⌘F hits the editor without a click', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    writeFileSync(join(repo, 'target.js'), 'const alpha = 1\n// alpha\n// alpha\nconst beta = alpha\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'target'], { cwd: repo })
    await startSession(page, repo)

    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()

    // ⌘P → type → pick the file. No editor.click() anywhere.
    await page.keyboard.press('Meta+P')
    const palette = page.locator('.palette')
    await expect(palette).toBeVisible()
    await palette.locator('.palette-input').fill('target.js')
    await palette.locator('.palette-item', { hasText: 'target.js' }).first().click()

    const editor = tile.locator('.editor-slot:visible .monaco-editor')
    await expect(editor).toBeVisible()
    // THE regression: focused straight after the ⌘P open (Monaco stamps
    // `.focused`), with no manual click.
    await expect(editor).toHaveClass(/focused/)

    // and so ⌘F opens OUR editor find bar and paints matches IN the editor
    await page.keyboard.press('Meta+F')
    const bar = tile.locator('.chat-find-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.chat-find-input')).toBeFocused()
    await bar.locator('.chat-find-input').fill('alpha')
    await expect(editor.locator('.hang4r-find-match').first()).toBeVisible()
  })

  test('⌘-click go-to-definition navigates cross-file from a ⌘P-opened file', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    writeFileSync(join(repo, 'lib.ts'), 'export function pingpong(): number {\n  return 42\n}\n')
    writeFileSync(join(repo, 'main.ts'), "import { pingpong } from './lib'\nconst r = pingpong()\n")
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'nav'], { cwd: repo })
    await startSession(page, repo)

    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()

    await page.keyboard.press('Meta+P')
    await expect(page.locator('.palette')).toBeVisible()
    await page.locator('.palette .palette-input').fill('main.ts')
    await page.locator('.palette .palette-item', { hasText: 'main.ts' }).first().click()

    const editor = tile.locator('.editor-slot:visible .monaco-editor')
    await expect(editor).toBeVisible()
    await expect(editor).toContainText('pingpong()')

    // ⌘-click the `pingpong` usage (line 2, the LAST occurrence) → go-to-def.
    // Resolves via the TS worker, or the git-grep fallback if it isn't ready yet.
    await editor.getByText('pingpong', { exact: true }).last().click({ modifiers: ['Meta'] })

    // navigated into lib.ts — the visible editor now shows its body
    await expect(editor).toContainText('return 42', { timeout: 15_000 })
  })
})
