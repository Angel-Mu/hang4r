import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * /remote-control hands the conversation to the terminal CLI: hang4r stops its
 * OWN agent (releaseForExternal) so the two don't fight (that collision drifted
 * the transcript and caused error_during_execution — Angel). The handoff must be
 * safe and reversible: the session isn't wedged, and hang4r takes control back on
 * the next prompt. (The full /remote-control flow runs a REAL claude CLI in a
 * terminal, which the fake harness can't do; this covers the handoff mechanism.)
 */
test('remote-control handoff releases hang4r cleanly and it takes over on the next prompt', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('do a first turn')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    const sessionId: string = await page.evaluate(async () => (await window.hang4r.listSessions())[0].id)

    // hand off (what /remote-control does under the hood) — stop hang4r's agent
    await page.evaluate((id) => window.hang4r.releaseForExternal(id), sessionId)
    // not wedged: still idle and ready
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible()
    await expect(tile.locator('.composer-input')).toBeEnabled()

    // hang4r takes control back on the next prompt (respawns its adapter)
    await tile.locator('.composer-input').fill('back in hang4r now')
    await tile.getByRole('button', { name: 'Send' }).click()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await expect(tile.locator('.msg-assistant').last()).toContainText('Working on it', {
      timeout: 15_000
    })
  } finally {
    await launched.app.close()
  }
})
