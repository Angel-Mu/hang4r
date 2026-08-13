import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A .csv opens straight into a readable TABLE preview (Angel: CSVs were an
 * unreadable wall of white text). The parser must keep a quoted, comma-bearing
 * field as ONE cell, and a Source toggle returns to the editable text.
 */
let launched: LaunchedApp | null = null
let extDir: string | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
  if (extDir) rmSync(extDir, { recursive: true, force: true })
  extDir = null
})

test('a CSV opens as a Table preview (quoted commas stay one cell) with a Source toggle', async () => {
  extDir = mkdtempSync(join(tmpdir(), 'hang4r-csv-'))
  const csv = join(extDir, 'people.csv')
  // row 2's name has a comma INSIDE quotes — a naive split would break the table
  writeFileSync(csv, 'Name,City,Zip\n"Doe, Jane",Urbana,61801\nBob,Champaign,61820\n')

  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('csv preview')
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
  }, csv)

  // defaults to the Table view — header + both data rows render as a grid
  const table = tile.locator('.csv-table')
  await expect(table).toBeVisible({ timeout: 10_000 })
  await expect(table.locator('thead th', { hasText: 'City' })).toBeVisible()
  // the quoted, comma-bearing name is ONE cell (not split into "Doe" | "Jane")
  await expect(table.locator('tbody td', { hasText: 'Doe, Jane' })).toHaveCount(1)
  await expect(table.locator('tbody td', { hasText: 'Champaign' })).toBeVisible()
  // 2 data rows
  await expect(table.locator('tbody tr')).toHaveCount(2)

  // Source toggle → the Monaco editor (still editable text)
  await tile.getByRole('tab', { name: 'Source' }).click()
  await expect(tile.locator('.editor-slot:visible .monaco-editor')).toBeVisible()
  await expect(table).toBeHidden()

  // back to Table
  await tile.getByRole('tab', { name: 'Table' }).click()
  await expect(tile.locator('.csv-table')).toBeVisible()
})
