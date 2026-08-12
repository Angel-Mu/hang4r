import { test, expect } from '@playwright/test'
import { basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, dragTo, type LaunchedApp } from './helpers'

/**
 * IDE drag-and-drop ergonomics (Angel's "more IDE capabilities" batch):
 *  - drag a tree file onto a folder → MOVE it there
 *  - drag an editor tab → REORDER it within its group
 * (Dropping an OS file onto the editor to open it isn't covered here — it needs
 *  a real OS file path via webUtils, which the fake harness can't synthesize.)
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function startWithFiles(page: LaunchedApp['page']): Promise<string> {
  const repo = makeScratchRepo() // README.md, docs.md, logo.svg, src/index.js, src/app.js
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await expect(page.locator('.project-name')).toHaveText(basename(repo))
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('dnd')
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  await tile.getByRole('button', { name: 'Files' }).click()
  await expect(tile.locator('.context-panel')).toBeVisible()
  return page.evaluate(
    () =>
      (window as unknown as { __hang4r_store: { getState(): { focusedSessionId: string } } })
        .__hang4r_store.getState().focusedSessionId
  )
}

test('dragging a tree file onto a folder moves it there', async () => {
  launched = await launchApp()
  const { page } = launched
  const sid = await startWithFiles(page)

  // docs.md (root) and src/ (folder) are both top-level rows
  await expect(page.locator('.file-row[data-path="docs.md"]')).toBeVisible()
  await expect(page.locator('.file-row[data-path="src"]')).toBeVisible()

  await dragTo(page, '.file-row[data-path="docs.md"]', '.file-row[data-path="src"]', 'center')

  // source of truth: the actual DISK directories (listDir), NOT listAllFiles —
  // that uses `git ls-files --cached`, which still lists a moved-but-not-git-rm'd
  // path, so it would report the old location even after a real fs move.
  await expect(async () => {
    const root = await page.evaluate((s) => window.hang4r.listDir(s, ''), sid)
    expect(root.map((e) => e.name)).not.toContain('docs.md')
    const src = await page.evaluate((s) => window.hang4r.listDir(s, 'src'), sid)
    expect(src.map((e) => e.name)).toContain('docs.md')
  }).toPass({ timeout: 10_000 })
  // and the root row is gone from the tree
  await expect(page.locator('.file-row[data-path="docs.md"]')).toHaveCount(0)
})

test('dragging an editor tab reorders it within the group', async () => {
  launched = await launchApp()
  const { page } = launched
  await startWithFiles(page)
  const tile = page.locator('.tile').first()

  // open two files → tabs in order [README.md, docs.md]
  await tile.locator('.file-row[data-path="README.md"]').click()
  await tile.locator('.file-row[data-path="docs.md"]').click()
  await expect(tile.locator('.editor-tab')).toHaveCount(2)
  const order = (): Promise<(string | null)[]> =>
    tile.locator('.editor-tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))
  expect(await order()).toEqual(['README.md', 'docs.md'])

  // drag docs.md before README.md → order flips
  await dragTo(page, '.editor-tab[data-path="docs.md"]', '.editor-tab[data-path="README.md"]', 'left')
  await expect(async () => expect(await order()).toEqual(['docs.md', 'README.md'])).toPass({
    timeout: 5_000
  })
})
