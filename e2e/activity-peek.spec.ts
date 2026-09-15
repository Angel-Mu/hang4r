import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel, for the fourth time: "I still cannot read nor see through the thinking
 * process."
 *
 * The words are not recoverable — the API streams pings and a token count during
 * redacted thinking, verified against the stream with and without
 * --forward-subagent-text. What IS available is what the agent DID, and
 * "Worked · 1 steps" hid exactly that behind a fold.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a collapsed activity row names the action, not just a step count', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('do a turn')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // the tail group stays open from the live turn — collapse it, which is the
  // state Angel is looking at when he scrolls back
  const group = tile.locator('.activity-group').first()
  await group.locator('.activity-header').click()
  await expect(group.locator('.activity-body')).toHaveCount(0)

  const peek = group.locator('.activity-peek')
  await expect(peek).toBeVisible({ timeout: 10_000 })
  expect((await peek.textContent())?.trim().length ?? 0).toBeGreaterThan(0)

  // reopening trades the summary back for the full list
  await group.locator('.activity-header').click()
  await expect(group.locator('.activity-peek')).toHaveCount(0)
  await expect(group.locator('.activity-body')).toBeVisible()
})
