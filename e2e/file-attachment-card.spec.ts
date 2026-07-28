import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A non-image file attachment must render as a CARD (name + type badge) in the
 * sent message — never the raw bytes inline (Angel: an attached PDF dumped
 * `%PDF-1.5…` as plain text). The card is clickable → opens a real preview, not
 * the binary. The agent still receives the file's text in the prompt.
 */
test('attached file renders as a card (not raw bytes) and click opens a preview', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    const marker = 'PREVIEW_MARKER_a1b2c3 — the readable document body'
    writeFileSync(join(repo, 'notes.md'), `# Notes\n\n${marker}\n`)
    execFileSync('git', ['add', 'notes.md'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'add notes'], { cwd: repo })

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('file card test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Attach notes.md via the + attach menu → a context chip (not an image chip).
    await tile.locator('.composer-attach').click()
    await expect(tile.locator('.attach-menu')).toBeVisible()
    await tile.locator('.attach-input').fill('notes')
    await tile.locator('.attach-item', { hasText: 'notes.md' }).first().click()
    await expect(tile.locator('.context-chip', { hasText: 'notes.md' })).toBeVisible()
    await page.keyboard.press('Escape')

    await tile.locator('.composer-input').fill('read this file')
    await tile.getByRole('button', { name: 'Send' }).click()

    // Sent message: a FILE CARD with the name + a badge — and the raw markdown
    // body must NOT be dumped inline as text.
    const card = tile.locator('.msg-user-file', { hasText: 'notes.md' }).first()
    await expect(card).toBeVisible({ timeout: 5_000 })
    await expect(card.locator('.msg-user-file-badge')).toHaveText('MD')
    await expect(tile.locator('.msg-user-card', { hasText: 'read this file' }).first()).not.toContainText(
      'PREVIEW_MARKER'
    )

    // Click the card → the file opens in a readable preview (not binary bytes).
    await card.click()
    await expect(page.locator('.lightbox-backdrop .lightbox-doc')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.lightbox-doc')).toContainText(marker)
    await page.keyboard.press('Escape')
    await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  } finally {
    await launched.app.close()
  }
})
