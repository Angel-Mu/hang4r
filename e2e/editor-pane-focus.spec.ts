import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "cmd+n to open new file in the IDE does not work if no other file is
 * open, it opens the new agent" and "when doing cmd+w … the second time closes
 * the session".
 *
 * One cause. focusPane() reads focus on <body> as "the conversation" — on
 * purpose, so a panel merely open behind the chat can never steal a key. But
 * nothing in the Files panel takes focus by itself: the tree rows are divs and
 * the editor area is empty, so the panel had no focus to claim and both
 * shortcuts fell through to session scope.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function filesPanel(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  await page.locator('.tile').first().getByRole('button', { name: 'Files' }).click()
  await expect(page.locator('.tile .files-view')).toBeVisible()
}

test('⌘N makes an untitled file with NO file open, instead of a new agent', async () => {
  launched = await launchApp()
  const { page } = launched
  await filesPanel(page)
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.editor-tab')).toHaveCount(0) // nothing open

  await tile.locator('.files-view').click()
  await page.keyboard.press('Meta+KeyN')

  await expect(page.locator('.dialog')).toHaveCount(0) // NOT the new-agent dialog
  await expect(tile.locator('.editor-tab', { hasText: 'Untitled' })).toBeVisible()
})

test('⌘W walks the open files instead of closing the session on the second press', async () => {
  launched = await launchApp()
  const { page } = launched
  await filesPanel(page)
  const tile = page.locator('.tile').first()

  await tile.locator('.file-row', { hasText: 'README.md' }).click()
  await tile.locator('.file-row', { hasText: 'docs.md' }).click()
  await expect(tile.locator('.editor-tab')).toHaveCount(2)
  await tile.locator('.editor-slot:visible .code-editor-preview').click()

  // first ⌘W closes the focused file and focus follows the one left
  await page.keyboard.press('Meta+KeyW')
  await expect(tile.locator('.editor-tab')).toHaveCount(1)
  await expect(page.locator('.tile')).toHaveCount(1)

  // second ⌘W closes THAT file, still not the session
  await page.keyboard.press('Meta+KeyW')
  await expect(tile.locator('.editor-tab')).toHaveCount(0)
  await expect(page.locator('.tile')).toHaveCount(1)
})

test('⌘W typed at the conversation still closes the session', async () => {
  launched = await launchApp()
  const { page } = launched
  await filesPanel(page)
  const tile = page.locator('.tile').first()
  await tile.locator('.file-row', { hasText: 'README.md' }).click()
  await expect(tile.locator('.editor-tab')).toHaveCount(1)

  // the guard the <body> rule exists for: a file being open must not steal ⌘W
  await tile.locator('.composer-input').click()
  await page.keyboard.press('Meta+KeyW')
  await expect(page.locator('.tile')).toHaveCount(0)
})
