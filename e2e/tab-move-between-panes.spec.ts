import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, dragTo, type LaunchedApp } from './helpers'

/**
 * Angel: "I'm still not able to place from a two panel File editor, a tab into
 * the other panel."
 *
 * The tab drop handler only ever reordered within the pane the drag started in —
 * a tab from another pane fell through and nothing happened.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function splitWithTwoFiles(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await tile.locator('.tile-tabs button', { hasText: /^Files$/ }).first().click()
  await tile.locator('.file-row[data-path="README.md"]').click()
  await expect(tile.locator('.editor-tab')).toHaveCount(1)

  // split, then open a second file so each pane holds one
  await tile.locator('.editor-slot:visible .code-editor-preview').first().click()
  await page.keyboard.press('Meta+Backslash')
  await expect(tile.locator('.editor-group')).toHaveCount(2)
  await tile.locator('.file-row[data-path="docs.md"]').click()
}

test('a file tab can be dragged into the other split pane', async () => {
  launched = await launchApp()
  const { page } = launched
  await splitWithTwoFiles(page)
  const tile = page.locator('.tile').first()

  // splitting copies the active file, so one pane holds README + docs and the
  // other holds README alone
  const docsPane = '.editor-group:has(.editor-tab[data-path="docs.md"])'
  const otherPane = '.editor-group:not(:has(.editor-tab[data-path="docs.md"]))'
  await expect(tile.locator(docsPane).locator('.editor-tab')).toHaveCount(2)
  await expect(tile.locator(otherPane).locator('.editor-tab')).toHaveCount(1)

  // move docs.md across to the pane that does not have it
  await dragTo(
    page,
    `${docsPane} .editor-tab[data-path="docs.md"]`,
    `${otherPane} .editor-tab[data-path="README.md"]`,
    'center'
  )

  await expect
    .poll(() => tile.locator('.editor-tab[data-path="docs.md"]').count(), { timeout: 10_000 })
    .toBe(1)
  // it landed in the pane that previously had only README
  await expect(
    tile.locator('.editor-group', { has: page.locator('.editor-tab[data-path="docs.md"]') })
      .locator('.editor-tab')
  ).toHaveCount(2)
})
