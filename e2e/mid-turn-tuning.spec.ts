import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "Monitors died with the session restart", followed by an
 * auto-"continue". Changing reasoning effort or ultracode tore the CLI process
 * down IMMEDIATELY — even mid-turn — killing everything living inside it
 * (subagents, workflows, Monitor watchers) and leaving a dangling tool call for
 * the next resume to heal. A mid-turn permission-mode change already deferred;
 * these did not.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function heldTurn(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  // parks the turn on a permission ask, so the turn is genuinely in flight
  await page.locator('.dialog-prompt').fill('ask permission to do a thing')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible({ timeout: 15_000 })
}

test('changing effort mid-turn does not kill the running turn', async () => {
  launched = await launchApp()
  const { page } = launched
  await heldTurn(page)

  const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
  await page.evaluate((id) => window.hang4r.setSessionEffort(id, 'high'), sid)

  // the held turn must still be answerable — if its process had been disposed,
  // the approval would go nowhere and the turn would never finish
  const perm = page.locator('.tile .permission-card').first()
  await expect(perm).toBeVisible({ timeout: 10_000 })
  await perm.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // and the change still took effect, once the turn was over
  expect(await page.evaluate((id) => window.hang4r.getSessionEffort(id), sid)).toBe('high')
})

test('toggling ultracode mid-turn does not kill the running turn either', async () => {
  launched = await launchApp()
  const { page } = launched
  await heldTurn(page)

  const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
  await page.evaluate((id) => window.hang4r.setSessionUltracode(id, true), sid)

  const perm = page.locator('.tile .permission-card').first()
  await expect(perm).toBeVisible({ timeout: 10_000 })
  await perm.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  expect(await page.evaluate((id) => window.hang4r.getSessionUltracode(id), sid)).toBe(true)
})

test('changing effort on an IDLE session still respawns right away', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
  await page.evaluate((id) => window.hang4r.setSessionEffort(id, 'max'), sid)
  // the next turn runs cleanly on the respawned process
  await page.locator('.composer-input').fill('go on')
  await page.locator('.composer-input').press('Enter')
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  expect(await page.evaluate((id) => window.hang4r.getSessionEffort(id), sid)).toBe('max')
})
