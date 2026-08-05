import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * "Add to chat" quotes a selection. When SENT, the quote must render as a wrapped
 * BLOCKQUOTE in the transcript — NOT a monospace, horizontally-scrolling code
 * block (Angel: add-to-chat gave weird code-block formatting on prose). The agent
 * still receives the fenced form; only the display is a blockquote.
 */
test('an "Add to chat" quote renders as a blockquote, not a code block', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('add to chat quote test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // put some prose in the conversation, then quote it via Add to chat
    const prose = 'QUOTED_PROSE_zk this is a long sentence that should wrap as a quote'
    await tile.locator('.composer-input').fill(prose)
    await tile.getByRole('button', { name: 'Send' }).click()
    const src = tile.locator('.msg-user-card', { hasText: 'QUOTED_PROSE_zk' }).first()
    await expect(src).toBeVisible({ timeout: 10_000 })

    await src.selectText()
    await src.click({ button: 'right' })
    await page.locator('.ctx-menu .ctx-item', { hasText: 'Add to chat' }).click()
    await expect(tile.locator('.context-chip')).toBeVisible()

    // send the quote (with a trailing typed note) and inspect how it renders
    await tile.locator('.composer-input').fill('my follow-up note')
    await tile.getByRole('button', { name: 'Send' }).click()

    const sent = tile.locator('.msg-user-card', { hasText: 'my follow-up note' }).last()
    await expect(sent).toBeVisible({ timeout: 10_000 })
    // the quote is a real blockquote…
    await expect(sent.locator('.msg-user-md blockquote')).toContainText('QUOTED_PROSE_zk')
    // …NOT a code block, and no literal ``` fences leaked into the display
    await expect(sent.locator('.msg-user-md pre')).toHaveCount(0)
    await expect(sent).not.toContainText('```')
    // and it doesn't overflow the chat horizontally
    const overflow = await tile
      .locator('.chat-scroll')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  } finally {
    await launched.app.close()
  }
})
