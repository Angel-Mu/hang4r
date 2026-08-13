import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A PDF opens in the media viewer with a PDF data-url <embed> (Angel: the PDF
 * tab was blank/spinning). This guards the READ + routing path — including an
 * out-of-tree PDF via the absolute-read revamp — so the embed gets a real
 * data:application/pdf src and isn't stuck on Loading…/error. (The visual render
 * itself needs webPreferences.plugins:true — Chromium's PDF viewer — which isn't
 * DOM-inspectable, so it's verified in the real app.)
 */
let launched: LaunchedApp | null = null
let extDir: string | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
  if (extDir) rmSync(extDir, { recursive: true, force: true })
  extDir = null
})

test('an out-of-tree PDF opens as a media-viewer embed with a data:application/pdf src', async () => {
  extDir = mkdtempSync(join(tmpdir(), 'hang4r-pdf-'))
  const pdf = join(extDir, 'generate-skill-guide.pdf') // OUTSIDE the worktree
  writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('pdf preview')
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await page.evaluate((p) => {
    const s = (
      window as unknown as {
        __hang4r_store: {
          getState(): { focusedSessionId: string; requestOpenFile(id: string, path: string): void }
        }
      }
    ).__hang4r_store.getState()
    s.requestOpenFile(s.focusedSessionId, p)
  }, pdf)

  const embed = tile.locator('.media-pdf embed')
  await expect(embed).toHaveCount(1, { timeout: 10_000 })
  await expect(embed).toHaveAttribute('src', /^data:application\/pdf/)
  await expect(embed).toHaveAttribute('type', 'application/pdf')
  // not stuck on the "Loading…" placeholder or the "cannot preview" error
  await expect(tile.locator('.media-viewer .media-empty')).toHaveCount(0)
})
