import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A session that finishes a turn while you AREN'T looking at it gets a "come
 * look" badge in the sidebar, so you can tell which one completed (Angel: after
 * a background session finished, he couldn't tell which needed attention). The
 * badge clears when you open/focus that session.
 */
test('a session that finishes while unfocused shows a sidebar badge, cleared on open', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    const { id: projectId } = await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // create a session with a first prompt WITHOUT opening it — it runs its turn
    // to completion in the background (never focused), so it should be flagged
    await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'bg session',
          firstPrompt: 'do the thing'
        }),
      projectId
    )

    const row = page.locator('.session-row', { hasText: 'bg session' }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    // it finished unfocused → the "finished, come look" badge appears
    await expect(row.locator('.session-flag-finished')).toBeVisible({ timeout: 20_000 })

    // opening it = you've seen it → the badge clears
    await row.click()
    await expect(row.locator('.session-flag-finished')).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await launched.app.close()
  }
})
