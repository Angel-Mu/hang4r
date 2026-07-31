import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A collapsed WORKSPACES group stays collapsed across an app restart.
 * Angel: workspaces re-expanded on every restart even when he'd collapsed them.
 * The collapse state is persisted per project id via getSetting/setSetting and
 * rehydrated in the store's init(); page.reload() re-runs init() from that same
 * persisted settings table, so it exercises the real restart round-trip.
 */
test('a collapsed workspace stays collapsed across a restart', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // give the workspace a session so the collapsible session list actually renders
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('collapse test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    const row = page.locator('.project-row').first()
    // starts expanded: no collapsed class, sessions visible
    await expect(row).not.toHaveClass(/project-row-collapsed/)
    await expect(page.locator('.project-sessions')).toBeVisible()

    // collapse it (clicking the name bubbles to the row's toggle)
    await page.locator('.project-name').first().click()
    await expect(row).toHaveClass(/project-row-collapsed/)
    await expect(page.locator('.project-sessions')).toHaveCount(0)

    // THE BUG: after a restart the collapse must persist
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-row').first()).toHaveClass(/project-row-collapsed/)
    await expect(page.locator('.project-sessions')).toHaveCount(0)

    // expanding again persists too (round-trips the removal)
    await page.locator('.project-name').first().click()
    await expect(page.locator('.project-row').first()).not.toHaveClass(/project-row-collapsed/)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-row').first()).not.toHaveClass(/project-row-collapsed/)
  } finally {
    await launched.app.close()
  }
})
