import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Cross-agent handoff: "Hand off to <agent>" starts a FRESH session on a DIFFERENT
 * backend, in the same worktree, seeded with this conversation's history (Angel:
 * hit my Claude limit, keep going on Codex). Not a native resume — the new agent
 * reads a reconstruction of the transcript. We drive the same bridge the context-
 * menu item calls, then confirm the new Codex session carries the seed.
 */
test('hand off a Claude session to Codex, seeded with the conversation', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('HANDOFF_SEED_marker_qz please help with the tests')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    const result = await page.evaluate(async () => {
      const sessions = await window.hang4r.listSessions()
      const src = sessions[0]
      const ns = await window.hang4r.forkToBackend(src.id, 'codex')
      // the fake adapter echoes the seed prompt into the new session — poll for it
      let seeded = ''
      for (let i = 0; i < 40; i++) {
        const events = await window.hang4r.getSessionEvents(ns.id)
        seeded = events
          .map((e) => e.event as { kind: string; text?: string })
          .filter((ev) => ev.kind === 'user-text')
          .map((ev) => ev.text ?? '')
          .join('\n')
        if (seeded.includes('HANDOFF_SEED_marker_qz')) break
        await new Promise((r) => setTimeout(r, 150))
      }
      return { srcBackend: src.backend, srcCwd: src.cwd, nsBackend: ns.backend, nsCwd: ns.cwd, nsTitle: ns.title, seeded }
    })

    // a FRESH session on the OTHER backend, in the SAME worktree
    expect(result.srcBackend).toBe('claude')
    expect(result.nsBackend).toBe('codex')
    expect(result.nsTitle).toContain('Codex')
    expect(result.nsCwd).toBe(result.srcCwd)
    // seeded with the takeover preamble AND the original conversation
    expect(result.seeded).toContain('taking over')
    expect(result.seeded).toContain('HANDOFF_SEED_marker_qz')
  } finally {
    await launched.app.close()
  }
})
