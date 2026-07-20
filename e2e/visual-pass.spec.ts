import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject } from './helpers'

/**
 * Visual QA sweep over the round-4 surfaces — captures screenshots of each
 * new piece of UI in BOTH themes for human/agent review. Not a regression
 * gate; opt-in:
 *   HANG4R_VISUAL=1 npx playwright test e2e/visual-pass.spec.ts
 * Output: test-results/visual/<theme>-<surface>.png
 */
test.describe('visual pass', () => {
  test.skip(process.env.HANG4R_VISUAL !== '1', 'set HANG4R_VISUAL=1 to run')
  test.setTimeout(240_000)

  for (const theme of ['dark', 'light'] as const) {
    test(`round-4 surfaces (${theme})`, async () => {
      const launched = await launchApp()
      const { app, page } = launched
      const shot = (name: string): Promise<Buffer> =>
        page.screenshot({ path: `test-results/visual/${theme}-${name}.png` })

      const repo = makeScratchRepo()
      await createProject(page, repo)
      await page.evaluate((t) => window.hang4r.setSetting('theme', t), theme)
      await page.reload()
      await page.waitForSelector('.app')

      // session up
      await page.locator('.project-row .ghost-btn').first().click()
      await page.locator('.dialog-prompt').fill('visual pass')
      await page.getByRole('button', { name: /Start agent/ }).click()
      const tile = page.locator('.tile').first()
      await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

      // 1 — search panel with results + replace text
      await tile.locator('.files-search-mode').click()
      const panel = tile.locator('.search-panel')
      await expect(panel).toBeVisible()
      await panel.locator('.search-input').first().fill('Docs')
      // reveal the replace row (collapsed by default behind the chevron)
      await panel.locator('.search-expand').click()
      await panel.locator('.search-input').nth(1).fill('Guides')
      await expect(panel.locator('.search-group-name').first()).toBeVisible({ timeout: 8_000 })
      await shot('search-panel')

      // 2 — composer autogrow with a long prompt
      const composer = tile.locator('.composer-input')
      await composer.fill(
        Array.from({ length: 14 }, (_, i) => `line ${i + 1} of a very long prompt that keeps going`).join('\n')
      )
      await shot('composer-autogrow')
      await composer.fill('')

      // 3 — rewind editor on the sent message
      const card = tile.locator('.msg-user-card').first()
      await card.hover()
      await card.locator('.msg-edit-btn').click()
      await expect(tile.locator('.msg-edit-input')).toBeVisible()
      await shot('rewind-editor')
      await tile.locator('.msg-edit-input').press('Escape')

      // 4 — diff media preview: drop a changed svg + png into the worktree
      const sessions = await page.evaluate(() => window.hang4r.listSessions())
      const cwd = sessions[0].cwd
      // 1x1 red png
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
      writeFileSync(join(cwd, 'shot.png'), png)
      writeFileSync(
        join(cwd, 'logo.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#50fa7b"/></svg>\n'
      )
      await tile.getByRole('button', { name: 'Diff', exact: true }).click()
      await expect(tile.locator('.diff-file-row, .changed-file-row').first()).toBeVisible({
        timeout: 10_000
      })
      // open the svg (modified media) if listed
      const svgRow = tile.locator('.diff-file-row, .changed-file-row', { hasText: 'logo.svg' })
      if (await svgRow.count()) {
        await svgRow.first().click()
        await page.waitForTimeout(400)
      }
      await shot('diff-media')

      // 5 — import picker (named sessions from this machine's real history)
      await page.locator('.archived-open-btn', { hasText: 'Import a session' }).click()
      await expect(page.locator('.import-dialog')).toBeVisible()
      await page.waitForTimeout(800)
      await shot('import-picker')
      await page.locator('.dialog-backdrop').click({ position: { x: 8, y: 8 } })
      await expect(page.locator('.import-dialog')).toHaveCount(0)

      // 6 — sidebar + titlebar (quiet indicators, toggle button); then collapsed
      await shot('overview')
      await page.locator('.titlebar-sidebar-toggle').click()
      await page.waitForTimeout(200)
      await shot('sidebar-hidden')
      await page.locator('.titlebar-sidebar-toggle').click()

      await app.close()
    })
  }
})
