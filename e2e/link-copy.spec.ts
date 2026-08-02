import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Right-clicking a rendered markdown link offers "Copy link address" and copies
 * the real target (the URL), NOT the rendered text (Angel: a "[this form]" link
 * should copy its https URL, not the words "this form"). Driven via a fenced
 * user message, which renders through the same markdown components as assistant
 * text. We spy on clipboard.writeText rather than read the OS clipboard (the
 * off-screen test window can't complete a real write, and we must not touch the
 * developer's real clipboard).
 */
test('right-click a markdown link copies its URL, not the rendered text', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('link copy test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // a fenced message renders as markdown → the [this form](url) becomes a link
    const url = 'https://example.com/apply-xyz-123'
    await tile
      .locator('.composer-input')
      .fill(`check [this form](${url}) now\n\n\`\`\`\nnoop\n\`\`\``)
    await tile.getByRole('button', { name: 'Send' }).click()

    const link = tile.locator('.msg-user-md a', { hasText: 'this form' }).first()
    await expect(link).toBeVisible({ timeout: 10_000 })
    // the visible text is the LABEL, not the URL — the whole point of the fix
    await expect(link).toHaveText('this form')

    // capture whatever the copy handler writes to the clipboard
    await page.evaluate(() => {
      const w = window as unknown as { __copied?: string }
      w.__copied = undefined
      ;(navigator.clipboard as unknown as { writeText: (t: string) => Promise<void> }).writeText = (
        t
      ) => {
        w.__copied = t
        return Promise.resolve()
      }
    })

    // right-click → the menu offers copying the link ADDRESS
    await link.click({ button: 'right' })
    const copyItem = page.locator('.ctx-menu .ctx-item', { hasText: 'Copy link address' })
    await expect(copyItem).toBeVisible({ timeout: 5_000 })
    await copyItem.click()

    // it copied the URL, not "this form"
    const copied = await page.evaluate(
      () => (window as unknown as { __copied?: string }).__copied
    )
    expect(copied).toBe(url)
  } finally {
    await launched.app.close()
  }
})

/**
 * Right-clicking selected conversation text gives a real context menu (Copy /
 * Add to chat) — Electron shows none by default, so before this you could only
 * use the floating "Add to chat" button (Angel: right-click did nothing).
 */
test('right-click on selected conversation text offers Copy and Add to chat', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('selection menu test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    const marker = 'SELECTABLE_PLAIN_WORDS_qz'
    await tile.locator('.composer-input').fill(`${marker} in the conversation`)
    await tile.getByRole('button', { name: 'Send' }).click()
    const msg = tile.locator('.msg-user-card', { hasText: marker }).first()
    await expect(msg).toBeVisible({ timeout: 10_000 })

    // select the message text, then right-click it
    await msg.selectText()
    await msg.click({ button: 'right' })

    const menu = page.locator('.ctx-menu')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    await expect(menu.locator('.ctx-item', { hasText: 'Copy' })).toBeVisible()
    await expect(menu.locator('.ctx-item', { hasText: 'Add to chat' })).toBeVisible()

    // Add to chat → the selection becomes a composer attachment chip
    await menu.locator('.ctx-item', { hasText: 'Add to chat' }).click()
    await expect(tile.locator('.context-chip')).toContainText(marker.slice(0, 10))
  } finally {
    await launched.app.close()
  }
})
