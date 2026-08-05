import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A ```mermaid fence renders as a live SVG diagram; if it can't render it falls
 * back to the raw code — never a blank box (Angel: a flowchart rendered empty).
 * Driven via a user message (fenced user messages render markdown since v1.0.47).
 */
test('a mermaid fence renders an SVG diagram, and an invalid one falls back to code', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('mermaid test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // a valid flowchart → renders as an SVG (debounced ~250ms + mermaid render)
    await tile.locator('.composer-input').fill('```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```')
    await tile.getByRole('button', { name: 'Send' }).click()
    await expect(tile.locator('.mermaid-svg svg')).toBeVisible({ timeout: 10_000 })

    // click the rendered diagram → it enlarges in the lightbox (Angel: hard to
    // read at chat width)
    await tile.locator('.mermaid-block-ready').first().click()
    await expect(page.locator('.lightbox-diagram svg')).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)

    // an invalid diagram falls back to the readable code, not a blank box
    await tile.locator('.composer-input').fill('```mermaid\n%%not-a-real-diagram%% @@@ !!!\n```')
    await tile.getByRole('button', { name: 'Send' }).click()
    const invalid = tile.locator('.msg-user-card', { hasText: 'not-a-real-diagram' }).first()
    await expect(invalid.locator('.md-code')).toBeVisible({ timeout: 10_000 })
    await expect(invalid.locator('.mermaid-block')).toHaveCount(0)
  } finally {
    await launched.app.close()
  }
})
