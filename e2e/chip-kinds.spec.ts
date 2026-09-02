import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: adding a conversation selection to chat "shows like it was from a
 * file". v1.0.133 gave every non-image attachment a file badge to make attached
 * JSON read as a file — which also stamped an extension badge on quoted prose.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a quoted selection is a reference, and a file selection names its lines', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
  await page.evaluate((id) => {
    const st = (window as unknown as {
      __hang4r_store: {
        getState(): {
          addAttachment(s: string, a: Record<string, unknown>): void
        }
      }
    }).__hang4r_store.getState()
    st.addAttachment(id, { label: '\u201cthe agent said something\u201d', text: 'quoted prose' })
    st.addAttachment(id, {
      label: 'README.md (26-35)',
      text: 'README.md:26-35\nbody',
      file: { name: 'README.md', path: 'README.md' }
    })
  }, sid)

  const chips = tile.locator('.composer-chips .context-chip')
  await expect(chips).toHaveCount(2)

  // a quoted selection is a reference: no extension badge
  await expect(chips.nth(0)).toHaveClass(/context-chip-quote/)
  await expect(chips.nth(0).locator('.chip-badge')).toHaveCount(0)

  // a file selection keeps the badge and names its line range, Cursor-style
  await expect(chips.nth(1)).toHaveClass(/context-chip-file/)
  await expect(chips.nth(1).locator('.chip-badge')).toHaveText('MD')
  await expect(chips.nth(1)).toContainText('README.md (26-35)')
})
