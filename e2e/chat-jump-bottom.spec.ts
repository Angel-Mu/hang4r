import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A long conversation needs a "jump to latest" affordance — scrolling back down
 * by hand (or after new messages arrive while you're reading up top) is a chore
 * (Angel). A button appears once the newest messages are off-screen and snaps
 * back to the bottom; it hides again when you're already at the bottom.
 */
test('a "jump to latest" button appears when scrolled up and returns to the bottom', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('jump button test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // A tall user message so the conversation overflows and becomes scrollable.
    const long = Array.from({ length: 220 }, (_, i) => `line ${i + 1}`).join('\n')
    await tile.locator('.composer-input').fill(long)
    await tile.getByRole('button', { name: 'Send' }).click()
    await expect(tile.locator('.msg-user-card').first()).toBeVisible({ timeout: 5_000 })
    // wait for the turn to finish — while it streams, the auto-pin keeps snapping
    // back to the bottom and would fight our scroll-to-top below
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    const scroll = tile.locator('.chat-scroll')
    // at the bottom (auto-pinned after send) → no button
    await expect(tile.locator('.chat-jump-bottom')).toBeHidden()

    // scroll to the top → the newest messages go off-screen → button appears
    await scroll.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(tile.locator('.chat-jump-bottom')).toBeVisible({ timeout: 3_000 })

    // click it → snaps back to the bottom and the button hides again
    await tile.locator('.chat-jump-bottom').click()
    await expect(tile.locator('.chat-jump-bottom')).toBeHidden({ timeout: 3_000 })
    await expect
      .poll(
        () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
        { timeout: 3_000 }
      )
      .toBeLessThan(80)
  } finally {
    await launched.app.close()
  }
})
