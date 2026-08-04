import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A workspace with many sessions shows the first 10, then a "Show more" button
 * that reveals the next batch (10 → 20 → …) without replacing the first ones —
 * so a busy workspace stays scannable without archiving (Angel).
 */
test('a workspace paginates sessions at 10 with a Show more button', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    const { id: projectId } = await createProject(page, repo)

    // 12 idle sessions in the one workspace (no first prompt → just created)
    await page.evaluate(async (pid) => {
      for (let i = 1; i <= 12; i++) {
        await window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: `sess-${String(i).padStart(2, '0')}`
        })
      }
    }, projectId)
    await page.reload()
    await page.waitForSelector('.app')

    // only the first 10 render, plus a "Show more" (2 hidden)
    await expect(page.locator('.session-row')).toHaveCount(10)
    const more = page.locator('.session-see-more')
    await expect(more).toBeVisible()
    await expect(more).toContainText('Show 2 more')

    // clicking reveals the rest WITHOUT replacing the first 10 → all 12 show
    await more.click()
    await expect(page.locator('.session-row')).toHaveCount(12)
    await expect(page.locator('.session-see-more')).toHaveCount(0)
  } finally {
    await launched.app.close()
  }
})
