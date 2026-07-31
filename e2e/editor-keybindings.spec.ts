import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * macOS IDE keybindings in the Monaco editor (Angel's reports):
 *  1. ⌘←/⌘→ jump to the start/end of the LINE (previously did nothing — the
 *     per-editor binding fired on the wrong editor once several files were open;
 *     now a global rule dispatches to the focused editor).
 *  2. Esc dismisses the autocomplete/suggest widget (previously a bare Escape
 *     command shadowed Monaco's built-in hideSuggestWidget).
 */
test.describe('editor — macOS keybindings', () => {
  let launched: LaunchedApp
  test.afterEach(async () => {
    await launched?.app.close()
  })

  const openFile = async (
    page: LaunchedApp['page'],
    repo: string,
    file: string,
    contents: string
  ): Promise<void> => {
    writeFileSync(join(repo, file), contents)
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo })
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('keybindings')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Files' }).click()
    await page.keyboard.press('Meta+P')
    await expect(page.locator('.palette')).toBeVisible()
    await page.locator('.palette .palette-input').fill(file)
    await page.locator('.palette .palette-item', { hasText: file }).first().click()
    await expect(tile.locator('.editor-slot:visible .monaco-editor')).toBeVisible()
  }

  test('⌘→ / ⌘← jump to end / start of the current LINE', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    // two lines — we edit line 2 to prove the jump is line-scoped, not doc-scoped
    await openFile(page, repo, 'nav.txt', 'line one here\nsecond line target\n')
    const editor = page.locator('.tile').first().locator('.editor-slot:visible .monaco-editor')

    // put the caret somewhere in the MIDDLE of line 2
    await editor.getByText('second line target').click()
    // ⌘→ to end of line, type a marker
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.type('E')
    // ⌘← to start of line, type a marker
    await page.keyboard.press('Meta+ArrowLeft')
    await page.keyboard.type('S')

    // markers landed at the two ends of line 2 → "Ssecond line targetE";
    // line 1 is untouched (the jump did not go to document start/end)
    await expect(editor).toContainText('Ssecond line targetE')
    await expect(editor).toContainText('line one here')
  })

  test('Esc closes the autocomplete suggestion widget', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await openFile(page, repo, 'suggest.txt', 'alphabet alpine altitude\n\n')
    const editor = page.locator('.tile').first().locator('.editor-slot:visible .monaco-editor')

    // type a prefix of an existing word, then force the suggest widget
    await editor.getByText('alphabet alpine altitude').click()
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('al')
    await page.keyboard.press('Control+Space')
    const suggest = editor.locator('.suggest-widget')
    await expect(suggest).toHaveClass(/visible/, { timeout: 5_000 })

    // THE fix: Escape dismisses it (it used to be swallowed by the git-peek Esc)
    await page.keyboard.press('Escape')
    await expect(suggest).not.toHaveClass(/visible/, { timeout: 5_000 })
  })
})
