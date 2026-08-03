import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A long unbreakable token in a message (e.g. a Playwright path with no spaces)
 * must WRAP inside the bubble, not spill past the container and make the chat
 * scroll sideways (Angel: text overflowed the message bubble).
 */
test('a long unbreakable token wraps and does not overflow the chat horizontally', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('overflow test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // a 320-char token with no break opportunities, rendered as markdown (fence)
    const longToken = 'x'.repeat(320)
    await tile.locator('.composer-input').fill(`${longToken}\n\n\`\`\`\nnoop\n\`\`\``)
    await tile.getByRole('button', { name: 'Send' }).click()

    const md = tile.locator('.msg-user-md').first()
    await expect(md).toBeVisible({ timeout: 10_000 })

    // the token wrapped: the chat viewport has no horizontal overflow
    const chatOverflow = await tile
      .locator('.chat-scroll')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(chatOverflow).toBeLessThanOrEqual(1)
    // and the bubble itself isn't wider than its own box (content fits)
    const mdOverflow = await md.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(mdOverflow).toBeLessThanOrEqual(1)
  } finally {
    await launched.app.close()
  }
})
