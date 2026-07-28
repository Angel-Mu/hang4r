import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Background-task cards can get stuck at "running" — a detached child whose
 * completion notification only arrives on the next turn, so hang4r can't confirm
 * it finished (Angel: 12 tasks stuck "running", no exit output, no way to clear).
 * The user can now dismiss a card (✕) or Clear them all — it hides the noise
 * without pretending to know the process state.
 */
test('background task cards can be dismissed individually and cleared in bulk', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('bg dismiss test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    await tile.getByRole('button', { name: 'Tasks', exact: true }).click()
    // the fake agent launches a background bash + a Workflow → two cards
    await expect(tile.locator('.bgtask')).toHaveCount(2, { timeout: 8_000 })

    // dismiss the first card via its ✕ → one card left
    await tile.locator('.bgtask').first().locator('.bgtask-dismiss').click()
    await expect(tile.locator('.bgtask')).toHaveCount(1)

    // Clear removes the rest — no background-task cards remain
    await tile.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(tile.locator('.bgtask')).toHaveCount(0)
    // the "Background tasks (N)" header is gone (the separate agent-todo list header stays)
    await expect(tile.locator('.bgtasks-header', { hasText: 'Background tasks' })).toHaveCount(0)
  } finally {
    await launched.app.close()
  }
})
