import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Keyboard-shortcut SCOPE routing (Angel: "you mess up the scope of the
 * shortcuts… make it work for good"). Every pane-scoped shortcut now routes by
 * where DOM focus actually is (`focusPane()`), not by which TILE is focused, so a
 * panel merely being OPEN in the focused tile never steals a key meant for the
 * conversation. ⌘N is the canonical case: new-file in the editor, new-agent
 * everywhere else — asserted in both directions here.
 */
test.describe('shortcut scope', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close().catch(() => {})
  })

  async function startSession(): Promise<{ tile: import('@playwright/test').Locator }> {
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('scope test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    return { tile }
  }

  test('⌘N in the conversation opens the new-agent dialog, even with the Files panel open', async () => {
    launched = await launchApp()
    const { page } = launched
    const { tile } = await startSession()

    // Files panel open (so scopedNewFile is registered) — the exact state that
    // used to make ⌘N create a file while typing in the chat.
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()

    // focus the conversation composer, NOT the editor
    const composer = tile.locator('.composer-input')
    await composer.click()
    await expect(composer).toBeFocused()

    await page.keyboard.press('Meta+N')

    // routes to the new-agent dialog; does NOT create an untitled editor buffer
    await expect(page.locator('.dialog-prompt')).toBeVisible()
    await expect(tile.locator('.editor-tab-name', { hasText: 'Untitled' })).toHaveCount(0)
  })

  test('⌘N with the editor focused makes a new untitled file, not the new-agent dialog', async () => {
    launched = await launchApp()
    const { page } = launched
    const { tile } = await startSession()

    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()
    await tile.locator('.file-row', { hasText: 'README.md' }).click()
    await tile.locator('.preview-source-tab', { hasText: 'Source' }).click()
    const editor = tile.locator('.editor-slot:visible .monaco-editor')
    await expect(editor).toBeVisible()
    await editor.click()

    await page.keyboard.press('Meta+N')

    // an untitled buffer opens in the editor; the new-agent dialog never appears
    await expect(tile.locator('.editor-tab-name', { hasText: 'Untitled' })).toHaveCount(1)
    await expect(page.locator('.dialog-prompt')).toHaveCount(0)
  })

  test('⌘D while typing in the conversation does NOT split a background terminal', async () => {
    launched = await launchApp()
    const { page } = launched
    const { tile } = await startSession()

    // Terminal open (so it registers ⌘D) — but focus stays in the conversation.
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-list-row')).toHaveCount(1)

    const composer = tile.locator('.composer-input')
    await composer.click()
    await expect(composer).toBeFocused()

    // ⌘D used to split the terminal from here (fired by focused-TILE). It must not.
    await page.keyboard.press('Meta+d')
    await expect(tile.locator('.terminal-list-row')).toHaveCount(1)
    await expect(tile.locator('.terminal-stack-split')).toHaveCount(0)
  })
})
