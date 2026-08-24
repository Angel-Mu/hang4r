import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A markdown file's ```mermaid fence renders as a live diagram in the EDITOR'S
 * markdown preview (shared mdComponents). Post file-open revamp, clicking a
 * file-attachment card opens the file as an editable tab; its Preview tab renders
 * the diagram — not a raw `graph TD …` fence, and not a read-only modal (Angel).
 */
test('the editor markdown preview renders a mermaid diagram, not raw code', async () => {
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

    // opens rendered — the fence is a live SVG, not raw code
    await expect(tile.locator('.code-editor-preview .mermaid-svg svg')).toBeVisible({ timeout: 10_000 })
    // …not the raw code fallback, and no modal
    await expect(tile.locator('.code-editor-preview pre.md-code')).toHaveCount(0)
    await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  } finally {
    await launched.app.close()
  }
})
