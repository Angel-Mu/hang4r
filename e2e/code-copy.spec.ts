import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Fenced code blocks in the conversation have a hover "Copy" button that copies
 * the block's exact text (Angel). We spy on clipboard.writeText — the off-screen
 * test window can't complete a real write, and we must never touch the dev's
 * clipboard.
 */
test('a code block has a copy button that copies its exact text', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('copy code test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

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

    const code = 'SELECT 1\nFROM t\nWHERE x = 42'
    await tile.locator('.composer-input').fill('here:\n```sql\n' + code + '\n```')
    await tile.getByRole('button', { name: 'Send' }).click()

    const block = tile.locator('.md-codeblock', { hasText: 'SELECT 1' }).first()
    await expect(block).toBeVisible({ timeout: 10_000 })
    await block.hover()
    await block.locator('.md-copy').click()

    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)
    expect(copied).toContain('SELECT 1')
    expect(copied).toContain('WHERE x = 42')
    // the button flips to a "copied" confirmation
    await expect(block.locator('.md-copy.md-copied')).toBeVisible()
  } finally {
    await launched.app.close()
  }
})
