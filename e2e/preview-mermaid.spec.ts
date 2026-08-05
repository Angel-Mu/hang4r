import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The file-preview modal (Lightbox) renders a ```mermaid fence as a diagram, the
 * same as the chat — it used a BARE markdown renderer with no mermaid override,
 * so a flowchart showed as raw `graph TD …` code (Angel). Opened by clicking a
 * file-attachment card, which routes through the shared mdComponents now.
 */
test('the preview modal renders a mermaid diagram, not raw code', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    writeFileSync(
      join(repo, 'diagram.md'),
      '# Flow\n\n```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```\n'
    )
    execFileSync('git', ['add', 'diagram.md'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'add diagram'], { cwd: repo })

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('preview mermaid test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // attach diagram.md and send → a file card in the transcript
    await tile.locator('.composer-attach').click()
    await expect(tile.locator('.attach-menu')).toBeVisible()
    await tile.locator('.attach-input').fill('diagram')
    await tile.locator('.attach-item', { hasText: 'diagram.md' }).first().click()
    await expect(tile.locator('.context-chip', { hasText: 'diagram.md' })).toBeVisible()
    await page.keyboard.press('Escape')
    await tile.locator('.composer-input').fill('render this')
    await tile.getByRole('button', { name: 'Send' }).click()

    const card = tile.locator('.msg-user-file', { hasText: 'diagram.md' }).first()
    await expect(card).toBeVisible({ timeout: 5_000 })
    await card.click()

    // the fence renders as a live SVG diagram inside the preview modal…
    await expect(page.locator('.lightbox-doc .mermaid-svg svg')).toBeVisible({ timeout: 10_000 })
    // …not the raw code fallback
    await expect(page.locator('.lightbox-doc pre.md-code')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  } finally {
    await launched.app.close()
  }
})
