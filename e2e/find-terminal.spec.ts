import { test, expect, type Page } from '@playwright/test'
import { basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Unified find bar (round 13 ①), TERMINAL scope: ⌘F over a focused terminal
 * opens OUR bar (the same `.chat-find-bar` chrome) scoped to that terminal's
 * scrollback, driving @xterm/addon-search. Pattern mirrors terminal-keymap's
 * bash-pinned real-PTY setup so matches actually exist in the buffer.
 */
test.describe('find bar — terminal scope', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  async function openTerminal(page: Page) {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.evaluate(() => window.hang4r.setSetting('terminalShell', '/bin/bash'))
    await expect(page.locator('.project-name')).toHaveText(basename(repo))
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('terminal find test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-panel')).toBeVisible()
    const term = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(term.locator('.xterm')).toBeVisible({ timeout: 15_000 })
    await expect(term).toContainText('bash-3.2$', { timeout: 10_000 })
    return { tile, term }
  }

  test('⌘F over a terminal opens the bar, finds buffer matches, Esc closes', async () => {
    launched = await launchApp()
    const { page } = launched
    const { tile, term } = await openTerminal(page)

    // print a marker several times so the scrollback has matches to find
    await term.click()
    await page.keyboard.type("printf 'ZEBRA\\nZEBRA\\nZEBRA\\n'")
    await page.keyboard.press('Enter')
    await expect(term).toContainText('ZEBRA')

    // ⌘F over the focused terminal → our bar, scoped to THIS terminal
    await page.keyboard.press('Meta+F')
    const bar = term.locator('.chat-find-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.chat-find-input')).toBeFocused()

    await bar.locator('.chat-find-input').fill('ZEBRA')
    // the addon reports a plausible match count (n/N with N >= 1)
    await expect(bar.locator('.chat-find-count')).toHaveText(/\/[1-9]\d*$/)

    // next / previous must not throw and keep the bar alive
    await bar.locator('.chat-find-input').press('Enter')
    await bar.locator('.chat-find-input').press('Shift+Enter')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.chat-find-count')).toHaveText(/\/[1-9]\d*$/)

    // Esc closes the bar
    await bar.locator('.chat-find-input').press('Escape')
    await expect(bar).toHaveCount(0)
  })
})
