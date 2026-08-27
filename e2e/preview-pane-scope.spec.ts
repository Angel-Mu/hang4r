import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "when cmd+w on a 'preview' file like an md, it closes the session
 * entirely… I also noticed that if we are on the scope of the editor, cmd+n does
 * not intend to create a new file".
 *
 * Both are one thing. Rendered markdown is not focusable, so clicking it drops
 * focus to <body> — which focusPane() reads as "the conversation" — and the
 * shortcuts fell through to their session-level meaning. Monaco takes focus for
 * the source side; the preview now does the same. v1.0.114 made this the common
 * case by opening previewable files rendered.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function previewOpen(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  const tile = page.locator('.tile').first()
  await tile.getByRole('button', { name: 'Files' }).click()
  await tile.locator('.file-row', { hasText: 'docs.md' }).click()
  // markdown opens RENDERED since v1.0.114 — this is the pane under test
  await expect(tile.locator('.code-editor-preview')).toBeVisible({ timeout: 10_000 })
}

test('⌘W in a rendered preview closes the FILE, not the session', async () => {
  launched = await launchApp()
  const { page } = launched
  await previewOpen(page)
  const tile = page.locator('.tile').first()

  // click the rendered text itself — the click that used to lose the pane
  await tile.locator('.code-editor-preview .markdown-body').click()
  await page.keyboard.press('Meta+KeyW')

  await expect(page.locator('.tile')).toHaveCount(1) // the session survives
  await expect(tile.locator('.editor-tab', { hasText: 'docs.md' })).toHaveCount(0)
})

test('⌘N from a rendered preview makes an untitled file, not a new agent', async () => {
  launched = await launchApp()
  const { page } = launched
  await previewOpen(page)
  const tile = page.locator('.tile').first()

  await tile.locator('.code-editor-preview .markdown-body').click()
  await page.keyboard.press('Meta+KeyN')

  await expect(page.locator('.dialog')).toHaveCount(0) // NOT the new-agent dialog
  await expect(tile.locator('.editor-tab', { hasText: 'Untitled' })).toBeVisible()
})

test('⌘W from the conversation still closes the session', async () => {
  launched = await launchApp()
  const { page } = launched
  await previewOpen(page)
  const tile = page.locator('.tile').first()

  // the guard that made case 1 exist: a shortcut typed at the conversation must
  // still mean the conversation, even with a preview open behind it
  await tile.locator('.composer-input').click()
  await page.keyboard.press('Meta+KeyW')
  await expect(page.locator('.tile')).toHaveCount(0)
})

// "…a new file that we could save with cmd+s or cmd+shift+s" — the untitled
// buffer is only useful if it can be named and written.
test('the untitled file it creates can be saved', async () => {
  launched = await launchApp()
  const { page } = launched
  await previewOpen(page)
  const tile = page.locator('.tile').first()

  await tile.locator('.code-editor-preview .markdown-body').click()
  await page.keyboard.press('Meta+KeyN')
  await expect(tile.locator('.editor-tab', { hasText: 'Untitled' })).toBeVisible()

  await tile.locator('.editor-slot:visible .monaco-editor').click()
  await page.keyboard.type('hello from an untitled buffer')
  await page.keyboard.press('Meta+KeyS')

  // ⌘S on an untitled buffer has to ASK for a name before it can write
  const prompt = page.locator('.input-dialog, .dialog')
  await expect(prompt).toBeVisible({ timeout: 10_000 })
})
