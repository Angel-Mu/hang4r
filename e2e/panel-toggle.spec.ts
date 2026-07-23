import { test, expect } from '@playwright/test'
import { basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, dragTo, type LaunchedApp } from './helpers'

/**
 * Cursor-style context-panel toggle (round 9, item ①⑥): ⌥⌘B shows/hides the
 * side panel, and while it's hidden a slim icon rail sits at the tile's
 * right edge as the collapsed representation of the panel.
 */
test.describe('context panel toggle', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('⌥⌘B toggles the panel; the rail shows only while collapsed', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-name')).toHaveText(basename(repo))

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('panel toggle test')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()

    // A new agent opens chat-only — no panel, so the collapsed rail shows.
    await expect(tile.locator('.context-panel')).toHaveCount(0)
    const rail = tile.locator('.context-rail')
    await expect(rail).toBeVisible()
    await expect(rail.locator('.context-rail-btn')).toHaveCount(4)

    // ⌥⌘B opens the panel, defaulting to Files since none was open yet — and
    // the rail (the panel's collapsed representation) disappears.
    await page.keyboard.press('Alt+Meta+B')
    await expect(tile.locator('.context-panel')).toBeVisible()
    await expect(tile.locator('.context-header')).toContainText('Files')
    await expect(rail).toHaveCount(0)

    // ⌥⌘B again closes it and the rail returns.
    await page.keyboard.press('Alt+Meta+B')
    await expect(tile.locator('.context-panel')).toHaveCount(0)
    await expect(rail).toBeVisible()

    // Clicking the rail's Terminal icon opens that surface directly.
    await rail.getByTitle('Open Terminal').click()
    await expect(tile.locator('.context-panel')).toBeVisible()
    await expect(tile.locator('.context-header')).toContainText('Terminal')
    await expect(rail).toHaveCount(0)

    // ⌥⌘B now remembers Terminal (the last-open tab), not the earlier Files.
    await page.keyboard.press('Alt+Meta+B')
    await expect(tile.locator('.context-panel')).toHaveCount(0)
    await page.keyboard.press('Alt+Meta+B')
    await expect(tile.locator('.context-header')).toContainText('Terminal')
  })

  test('the open panel survives a workspace re-split (QA hunt #10)', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // session A with its Terminal panel open
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('panel survivor A')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tileA = page.locator('.tile').first()
    await expect(tileA.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tileA.getByRole('button', { name: 'Terminal' }).click()
    await expect(tileA.locator('.context-header')).toContainText('Terminal')

    // session B opens single (replaces A) — reopen A, panel must still be Terminal
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('panel survivor B')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.pane')).toHaveCount(1)
    await page.locator('.session-row', { hasText: 'panel survivor A' }).click()
    await expect(page.locator('.tile').first().locator('.context-header')).toContainText('Terminal')

    // drag B onto A's right half → 2 panes; A's tile remounts under a new
    // tree shape (the QA hunt #10 bug: this used to reset the panel to chat)
    // A is focused, so B is the one non-focused row (same idiom as session-flow)
    await dragTo(page, '.session-row:not(.session-row-focused)', '.pane', 'right')
    await expect(page.locator('.pane')).toHaveCount(2)
    await expect(
      page.locator('.pane').first().locator('.context-header')
    ).toContainText('Terminal', { timeout: 10_000 })
  })

  test('a session switch does not replay a stale open-signal onto the restored tab', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // session A: open Terminal via ⌃` — this leaves a `terminalToToggle` signal
    // pending in the store (unlike clicking the tab, which sets state directly)
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('replay A')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tileA = page.locator('.tile').first()
    await expect(tileA.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await page.keyboard.press('Control+Backquote')
    await expect(tileA.locator('.context-header')).toContainText('Terminal')

    // session B replaces A in the single pane, then switch back to A. Without the
    // nonce guard, A's remount replayed the stale ⌃` signal and toggled Terminal
    // back OFF (Angel: returned to a session and the panel had changed/closed).
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('replay B')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.pane')).toHaveCount(1)
    await page.locator('.session-row', { hasText: 'replay A' }).click()
    // A's Terminal panel is still open — the stale signal did NOT re-fire
    await expect(page.locator('.tile').first().locator('.context-header')).toContainText('Terminal')
  })
})
