import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Keyboard shortcuts must route by WHERE focus actually is, not by which tile is
 * focused. Angel hit three focus-routing bugs at once:
 *  - ⌘F while reading the conversation opened the EDITOR's find bar (the capture
 *    handler treated body-focus as "nowhere → editor").
 *  - ⌘W from the conversation closed a background editor file (scopedClose fired
 *    even though focus wasn't in a pane), leaving the tile blank instead of
 *    closing the session.
 *  - ⌘S saved the wrong editor / did nothing (shared Monaco keybinding service).
 * The fake agent gives a deterministic idle session + a README to open.
 */

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function startSession(page: LaunchedApp['page'], prompt: string): Promise<void> {
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill(prompt)
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile').first().locator('.status-dot.status-idle')).toBeVisible({
    timeout: 20_000
  })
}

async function openReadme(tile: ReturnType<LaunchedApp['page']['locator']>): Promise<void> {
  await tile.getByRole('button', { name: 'Files' }).click()
  await expect(tile.locator('.context-panel')).toBeVisible()
  await tile.locator('.file-row', { hasText: 'README.md' }).click()
  // markdown opens rendered; these tests drive the Monaco editor
  await tile.locator('.preview-source-tab', { hasText: 'Source' }).click()
  await expect(tile.locator('.editor-slot:visible .monaco-editor')).toBeVisible()
}

test('⌘F while focus is in the conversation opens CONVERSATION find, even with an editor open', async () => {
  launched = await launchApp()
  const { page } = launched
  await startSession(page, 'turn one')
  const tile = page.locator('.tile').first()

  // a visible editor exists — the bug would send ⌘F here
  await openReadme(tile)

  // click in the conversation TEXT (not the composer) — focus drops to <body>
  await tile.locator('.msg-assistant').first().click()

  await page.keyboard.press('Meta+f')
  await expect(page.locator('[placeholder="Find in conversation"]')).toBeVisible()
  await expect(page.locator('[placeholder="Find in file"]')).toHaveCount(0)
})

test('⌘F while the editor is focused still opens the FILE find (not hijacked to conversation)', async () => {
  launched = await launchApp()
  const { page } = launched
  await startSession(page, 'turn one')
  const tile = page.locator('.tile').first()
  await openReadme(tile)

  await tile.locator('.editor-slot:visible .monaco-editor').click()
  await page.keyboard.press('Meta+f')
  await expect(page.locator('[placeholder="Find in file"]')).toBeVisible()
  await expect(page.locator('[placeholder="Find in conversation"]')).toHaveCount(0)
})

test('⌘W from the conversation closes the whole session tile, not a background editor file', async () => {
  launched = await launchApp()
  const { page } = launched
  await startSession(page, 'only session')
  const tile = page.locator('.tile').first()

  // open a file so FileBrowser registers scopedClose — the thing that used to
  // swallow ⌘W and close the file (leaving a blank tile) instead of the session
  await openReadme(tile)

  // focus the conversation composer, then ⌘W
  await tile.locator('.composer-input').click()
  await page.keyboard.press('Meta+KeyW')

  // the only session tile is gone → the empty workspace shows
  await expect(page.locator('.tile')).toHaveCount(0)
  await expect(page.locator('.workspace-empty')).toBeVisible()
})

test('⌘W while the editor is focused closes the FILE first, keeping the session open', async () => {
  launched = await launchApp()
  const { page } = launched
  await startSession(page, 'keep me')
  const tile = page.locator('.tile').first()
  await openReadme(tile)

  // focus the editor, then ⌘W — closes the file tab, NOT the session tile
  await tile.locator('.editor-slot:visible .monaco-editor').click()
  await page.keyboard.press('Meta+KeyW')

  await expect(page.locator('.tile')).toHaveCount(1) // session still open
  await expect(tile.locator('.editor-tab')).toHaveCount(0) // the file tab closed
})

test('⌘S saves the focused editor (dirty dot clears)', async () => {
  launched = await launchApp()
  const { page } = launched
  await startSession(page, 'save me')
  const tile = page.locator('.tile').first()
  await openReadme(tile)

  // type into the editor → the tab goes dirty
  await tile.locator('.editor-slot:visible .monaco-editor').click()
  await page.keyboard.type('// edit\n')
  await expect(tile.locator('.editor-tab-dirty')).toHaveCount(1)

  // ⌘S writes it back — the dirty dot clears
  await page.keyboard.press('Meta+s')
  await expect(tile.locator('.editor-tab-dirty')).toHaveCount(0)
})
