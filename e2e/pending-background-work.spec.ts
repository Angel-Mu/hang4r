import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel, relaying a user: "hang4r no te está diciendo que anda esperando a los
 * workflows, se pone como que ya terminó pero pues está esperando las respuestas
 * del server."
 *
 * The fix is the WORD: the last turn's footer says what it is waiting on instead
 * of "done". An earlier attempt also put a button above the composer; Angel
 * asked what it was and had it removed — one indicator, where the wrong word was.
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

  // the footer must NOT say "done" — that is the word Angel reads
  const footer = page.locator('.tile .turn-info').last()
  await expect(footer).toContainText('waiting on')
  await expect(footer).toContainText('1 agent')
  await expect(footer).not.toContainText('done')

  // there is no second indicator to disagree with it
  await expect(page.locator('.composer-runs')).toHaveCount(0)
})

test('the Subagents panel agrees with the footer', async () => {
  launched = await launchApp()
  const { page } = launched
  await turnWithBackgroundAgents(page)

  await page.locator('.tile-tabs button', { hasText: 'Subagents' }).click()
  const panel = page.locator('.tile .subagent-run')
  await expect(panel.filter({ hasText: 'long haul research' })).toContainText(
    'running in background'
  )
  // …and after a CLEAN turn the resultless run is not called "running" either,
  // nor accused of failing
  await expect(panel.filter({ hasText: 'the one that never returns' })).not.toContainText(
    'running'
  )
})

test('a session that has taken no turn says nothing about pending work', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await expect(page.locator('.tile .turn-info-waiting')).toHaveCount(0)
})

// Angel, on 1.0.123: "I have updated to the version you enhanced, the done but
// really is not done". A Monitor had been armed — the turn read "done", the
// Tasks panel said "No tasks yet", and the strip counted subagents only. Monitor
// and Workflow return immediately by design and keep working; they now count.
test('an armed watcher keeps the finished turn from reading as the last word', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('arm a monitor')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  const footer = page.locator('.tile .turn-info').last()
  await expect(footer).toContainText('waiting on')
  await expect(footer).toContainText('Monitor')
  await expect(footer).not.toContainText('done')

  await expect(page.locator('.composer-runs')).toHaveCount(0)
})


// The other half of the same rule: a turn that ABORTED really can strand a run,
// and only there is "no result" the honest label.
test('an aborted turn does strand its unfinished run', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('abort mid subagent')
  await page.getByRole('button', { name: /Start agent/ }).click()

  // an aborted turn is the one case where "no result" is honest; it shows in the
  // Subagents panel, which is where a per-run status belongs
  await page.locator('.tile-tabs button', { hasText: 'Subagents' }).click()
  await expect(page.locator('.tile .subagent-run').first()).toContainText('no result', {
    timeout: 20_000
  })
})

// The footer can't reach you from another session, so the sidebar row carries
// the same fact. Cyan, deliberately not amber: amber already means "blocked on
// you" (a permission wait), and this needs nothing from you.
test('the sidebar marks a session that is still working after its turn', async () => {
  launched = await launchApp()
  const { page } = launched
  await turnWithBackgroundAgents(page)

  const row = page.locator('.session-row').first()
  await expect(row.locator('.status-dot.status-pending')).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.status-dot.status-awaiting')).toHaveCount(0)
})
