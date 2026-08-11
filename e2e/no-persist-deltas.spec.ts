import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Streaming token fragments (block-delta) must NOT be persisted — older builds
 * wrote one SQLite row per token, bloating the DB past 200k rows and doing a
 * synchronous write per token on the main loop, which froze session switches
 * while a turn was streaming (Angel). block-final carries the whole block's text,
 * so deltas are broadcast for LIVE display only and the reload is identical.
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('block-delta streams live but is never persisted; the message survives a reload', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('turn one')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  // the streamed assistant text is present — proving the live deltas were applied
  await expect(tile.locator('.msg-assistant', { hasText: 'Working on it' })).toBeVisible()

  const sid = await page.evaluate(
    () =>
      (window as unknown as { __hang4r_store: { getState(): { focusedSessionId: string } } })
        .__hang4r_store.getState().focusedSessionId
  )
  const kinds = await page.evaluate(async (s) => {
    const evs = (await window.hang4r.getSessionEvents(s)) as { event: { kind: string } }[]
    return evs.map((e) => e.event.kind)
  }, sid)
  // deltas were shown live but NEVER written to the transcript DB...
  expect(kinds).not.toContain('block-delta')
  // ...while block-final (the complete text) WAS persisted
  expect(kinds).toContain('block-final')

  // reload: the transcript rebuilds from block-final alone — message still intact
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row').first().click()
  await expect(
    page.locator('.tile').first().locator('.msg-assistant', { hasText: 'Working on it' })
  ).toBeVisible({ timeout: 20_000 })
})
