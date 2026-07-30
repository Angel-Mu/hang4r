import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The composer's draft lives in the store, so every keystroke re-renders
 * SessionTile — ChatView is memoized so it doesn't re-render the whole transcript
 * each keystroke (the typing-lag fix, Angel). This guards that the memo doesn't
 * break reactivity: prior messages persist while typing, and new sends still show.
 */
test('typing in the composer keeps the conversation intact and new sends still appear', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('hello marker')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await expect(tile.locator('.msg-user-card', { hasText: 'hello marker' })).toBeVisible()

    // type a long draft — the memoized chat must still show the earlier message
    const long = 'x'.repeat(200)
    await tile.locator('.composer-input').fill(long)
    await expect(tile.locator('.composer-input')).toHaveValue(long)
    await expect(tile.locator('.msg-user-card', { hasText: 'hello marker' })).toBeVisible()

    // a new send still appears (memo re-renders when the transcript changes)
    await tile.locator('.composer-input').fill('second marker')
    await tile.getByRole('button', { name: 'Send' }).click()
    await expect(tile.locator('.msg-user-card', { hasText: 'second marker' })).toBeVisible({
      timeout: 5_000
    })
  } finally {
    await launched.app.close()
  }
})
