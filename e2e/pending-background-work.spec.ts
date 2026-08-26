import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel, relaying a user: "hang4r no te está diciendo que anda esperando a los
 * workflows, se pone como que ya terminó pero pues está esperando las respuestas
 * del server." The turn footer said "done" and nothing else in the conversation
 * mentioned the agents still working — you had to open the panel and ask.
 *
 * The second half is the status itself: an ordinary subagent runs IN-PROCESS, so
 * once the turn ends it cannot still be running. Runs left at "running" were the
 * ones Angel could never stop — there was nothing left to stop.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function turnWithBackgroundAgents(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('spawn background agents')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
}

test('a finished turn says what it left running, instead of only "done"', async () => {
  launched = await launchApp()
  const { page } = launched
  await turnWithBackgroundAgents(page)

  // the turn itself is done…
  await expect(page.locator('.tile .turn-info').last()).toContainText('done')

  // …but the conversation now says what outlived it, without opening anything
  const strip = page.locator('.composer-runs')
  await expect(strip).toBeVisible()
  await expect(strip).toContainText('1 agent still running in the background')
  await expect(strip).toContainText('1 ended with no result')
})

test('the strip opens the Subagents panel, where the statuses agree with it', async () => {
  launched = await launchApp()
  const { page } = launched
  await turnWithBackgroundAgents(page)

  await page.locator('.composer-runs').click()
  const panel = page.locator('.tile .subagent-run')
  await expect(panel.filter({ hasText: 'long haul research' })).toContainText(
    'running in background'
  )
  // the run that never returned reads honestly instead of "running" forever
  await expect(panel.filter({ hasText: 'the one that never returns' })).toContainText(
    'no result'
  )
})

test('a plain turn leaves nothing pending — no strip', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('just a normal turn')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await expect(page.locator('.composer-runs')).toHaveCount(0)
})
