import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * ⌘F in the rendered MARKDOWN preview must search the PREVIEW DOM, not the
 * hidden Monaco source (Angel: it counted matches you couldn't see/scroll to).
 * It reuses the chat's Custom-Highlight DOM find, scoped to the preview.
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('⌘F over the markdown preview finds + highlights in the rendered preview', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo() // docs.md = "# Docs Title\n\nSome **bold** preview text."
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('preview find')
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await tile.getByRole('button', { name: 'Files' }).click()
  await tile.locator('.file-row[data-path="docs.md"]').click()

  // markdown already opens in Preview; the click puts focus on a control inside
  // the editor pane, so ⌘F routes to the editor, not the conversation
  await tile.locator('.preview-source-tab', { hasText: 'Preview' }).click()
  await expect(tile.locator('.code-editor-preview .markdown-body')).toBeVisible()

  await page.keyboard.press('Meta+f')
  // the PREVIEW find bar opens — NOT Monaco's "Find in file"
  const bar = page.locator('[placeholder="Find in preview"]')
  await expect(bar).toBeVisible()
  await expect(page.locator('[placeholder="Find in file"]')).toHaveCount(0)

  await bar.fill('preview')
  await expect(tile.locator('.chat-find-count')).toHaveText('1/1')

  // the match is really highlighted in the preview DOM (Custom Highlight registry)
  const hl = await page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Iterable<unknown>> }).highlights.get(
      'chat-find'
    )
    return h ? Array.from(h).length : -1
  })
  expect(hl).toBe(1)
})
