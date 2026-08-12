import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The file-open revamp (Angel: dropping/clicking a file opened a read-only MODAL
 * instead of an editable tab). A file OUTSIDE the worktree now opens as a real,
 * editable editor tab (the editor reads/writes absolute paths directly), and ⌘S
 * writes it back to its actual location — no lightbox.
 */
let launched: LaunchedApp | null = null
let extDir: string | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
  if (extDir) rmSync(extDir, { recursive: true, force: true })
  extDir = null
})

test('an out-of-tree file opens as an editable tab (no modal); ⌘S writes it back', async () => {
  extDir = mkdtempSync(join(tmpdir(), 'hang4r-ext-'))
  const extFile = join(extDir, 'external.csv') // OUTSIDE the session's worktree
  writeFileSync(extFile, 'name,value\nalpha,1\n')

  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('external file')
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // open the absolute out-of-tree path — as a clicked conversation path / drop does
  await page.evaluate((p) => {
    const s = (
      window as unknown as {
        __hang4r_store: {
          getState(): { focusedSessionId: string; requestOpenFile(id: string, path: string): void }
        }
      }
    ).__hang4r_store.getState()
    s.requestOpenFile(s.focusedSessionId, p)
  }, extFile)

  // it opened as an EDITABLE tab — content shown, NO modal
  const editor = tile.locator('.editor-slot:visible .monaco-editor')
  await expect(editor).toBeVisible({ timeout: 10_000 })
  await expect(editor).toContainText('alpha')
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  await expect(tile.locator('.editor-tab', { hasText: 'external.csv' })).toBeVisible()

  // edit at the top of the file and ⌘S → the real file on disk changes
  await editor.click()
  await page.keyboard.press('Meta+ArrowUp') // cursor to file top
  await page.keyboard.type('ZZZ\n')
  await page.keyboard.press('Meta+s')
  await expect.poll(() => readFileSync(extFile, 'utf8'), { timeout: 10_000 }).toContain('ZZZ')
})
