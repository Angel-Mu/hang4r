import { test, expect } from '@playwright/test'
import { basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Cmd+F "find in conversation" (round 12 ③): a floating find bar scoped to
 * the focused tile's chat transcript, driven with the deterministic fake
 * agent (its subagent line "…found 2 matches." repeats once per turn, giving
 * a reliable multi-match term without seeding fixture text).
 */
test.describe('chat find', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('⌘F opens a find bar scoped to the focused tile, navigates matches, and Esc closes it', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-name')).toHaveText(basename(repo))

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('turn one')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // two more turns — the fake agent says "Working on it — turn N." once per
    // turn, so "Working" appears 3 times in the VISIBLE transcript (subagent
    // rows are panel-only now and don't count)
    const composer = tile.locator('.composer-input')
    await composer.fill('turn two')
    await composer.press('Enter')
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await composer.fill('turn three')
    await composer.press('Enter')
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await expect(tile.locator('.msg-assistant', { hasText: 'Working on it' })).toHaveCount(3)

    // ⌘F opens the find bar, auto-focused
    await page.keyboard.press('Meta+F')
    const bar = tile.locator('.chat-find-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.chat-find-input')).toBeFocused()

    await bar.locator('.chat-find-input').fill('Working')
    await expect(bar.locator('.chat-find-count')).toHaveText('1/3')

    // Enter advances to the next match
    await bar.locator('.chat-find-input').press('Enter')
    await expect(bar.locator('.chat-find-count')).toHaveText('2/3')
    await bar.locator('.chat-find-input').press('Enter')
    await expect(bar.locator('.chat-find-count')).toHaveText('3/3')
    // wraps back to the first match
    await bar.locator('.chat-find-input').press('Enter')
    await expect(bar.locator('.chat-find-count')).toHaveText('1/3')
    // Shift+Enter goes backward (wraps the other way)
    await bar.locator('.chat-find-input').press('Shift+Enter')
    await expect(bar.locator('.chat-find-count')).toHaveText('3/3')

    // matches are registered via the CSS Custom Highlight API, not a
    // DOM-mutating <mark> — assert the highlight registry actually holds all
    // 3 ranges (proves the find pass ran, not just the counter UI)
    const highlightCount = await page.evaluate(() => {
      const hl = (CSS as unknown as { highlights: Map<string, Iterable<unknown>> }).highlights.get(
        'chat-find'
      )
      return hl ? Array.from(hl).length : -1
    })
    expect(highlightCount).toBe(3)

    // Esc closes the bar and returns focus to the composer
    await bar.locator('.chat-find-input').press('Escape')
    await expect(bar).toHaveCount(0)
    await expect(composer).toBeFocused()
  })

  test('⌘F over the Monaco editor opens the find bar in file scope, not conversation scope', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('open a file')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // open the Files panel and load a file into the Monaco editor
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()
    await tile.locator('.file-row', { hasText: 'README.md' }).click()
    const editor = tile.locator('.editor-slot:visible .monaco-editor')
    await expect(editor).toBeVisible()
    await editor.click()

    await page.keyboard.press('Meta+F')
    // The unified bar opens in EDITOR scope (placeholder "Find in file") — not
    // the conversation scope, and not Monaco's built-in find widget (round 13 ①).
    const bar = tile.locator('.chat-find-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.chat-find-input')).toHaveAttribute('placeholder', 'Find in file')
    await expect(editor.locator('.find-widget')).toHaveCount(0)
  })
})
