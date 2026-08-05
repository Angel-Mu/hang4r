import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A file referenced by a RELATIVE path from the conversation that lives in a
 * SIBLING worktree (this session runs in ONE worktree, but the agent wrote the
 * file in another) now resolves for preview — clicking it used to error and force
 * Finder (Angel). previewAttachment enumerates the repo's worktrees and opens the
 * match; here we exercise it through the bridge with a relative external path.
 */
test('a relative path living in a sibling worktree resolves for preview', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  const rand = Math.random().toString(36).slice(2, 8)
  try {
    const repo = makeScratchRepo()
    // a sibling worktree with a file that is NOT in the main checkout
    const sib = join(repo, '..', `hang4r-sib-${rand}`)
    execFileSync('git', ['worktree', 'add', '-b', `sibling-${rand}`, sib], { cwd: repo })
    mkdirSync(join(sib, 'docs', 'specs'), { recursive: true })
    const marker = `CROSS_WT_${rand} — lives only in the sibling worktree`
    writeFileSync(join(sib, 'docs', 'specs', 'file.md'), `# spec\n\n${marker}\n`)

    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('cross worktree test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    const sessionId = await page.evaluate(async () => (await window.hang4r.listSessions())[0].id)

    // the relative path is NOT in this session's worktree — resolves via the sibling
    const res = await page.evaluate(
      ([sid]) => window.hang4r.previewAttachment(sid, 'docs/specs/file.md', true),
      [sessionId] as const
    )
    expect(res?.text ?? '').toContain(`CROSS_WT_${rand}`)

    // a path that exists in NO worktree still fails cleanly (null, no crash)
    const missing = await page.evaluate(
      ([sid]) => window.hang4r.previewAttachment(sid, 'docs/specs/does-not-exist.md', true),
      [sessionId] as const
    )
    expect(missing).toBeNull()
  } finally {
    await launched.app.close()
  }
})
