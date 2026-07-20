import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, dragTo, type LaunchedApp } from './helpers'

/**
 * Angel's two drag-drop product calls (Jul 15):
 * - dropping a pane onto its OWN edge is a no-op, never a reorder
 * - a drop while a pane is EXPANDED auto-un-expands so the new split is visible
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function twoSessions(page: LaunchedApp['page']): Promise<void> {
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  for (const title of ['Alpha', 'Beta']) {
    await page.evaluate(
      ({ pid, title }) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title,
          firstPrompt: 'hello'
        }),
      { pid: project.id, title }
    )
  }
  await page.reload()
  await page.waitForSelector('.app')
}

test('dropping a pane onto its own edge is a no-op (order unchanged)', async () => {
  launched = await launchApp()
  const { page } = launched
  await twoSessions(page)

  // open Alpha, then split with Beta on the right → [Alpha, Beta]
  await page.locator('.session-row', { hasText: 'Alpha' }).click()
  await dragTo(page, '.session-title[title="Beta"]', '.pane', 'right')
  await expect(page.locator('.pane')).toHaveCount(2)
  await expect(page.locator('.pane .tile-title').first()).toHaveText('Alpha')

  // drag Alpha's pane onto its OWN left edge — used to flip to [Beta, Alpha]
  await dragTo(page, '.pane:nth-child(1) .tile-title', '.pane:nth-child(1)', 'left')
  await expect(page.locator('.pane')).toHaveCount(2)
  await expect(page.locator('.pane .tile-title').first()).toHaveText('Alpha')
  await expect(page.locator('.pane .tile-title').nth(1)).toHaveText('Beta')
})

// NOTE on the second product call (drop-while-expanded auto-un-expands): the
// original repro dragged a SIDEBAR row onto an expanded pane — but expand mode
// hides the sidebar entirely now (session-flow: "expand hides the sidebar"),
// so there is no user-reachable drag source while expanded. The store guard
// (dropSessionOnPane clears expandedSessionId) stays as belt-and-braces for
// any future drop source; it has no drivable UI path to e2e today.
