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
  const dot = row.locator('.status-dot.status-pending')
  await expect(dot).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.status-dot.status-awaiting')).toHaveCount(0)

  // toBeVisible passes on an unstyled dot — it still has size. Asserting the
  // painted colour is what catches a class with no rule behind it, which is
  // exactly how the pending dot shipped invisible in v1.0.126.
  const painted = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(painted).not.toBe('rgba(0, 0, 0, 0)')
  expect(painted).not.toBe('transparent')
})

// Angel: "is it possible to click on it and take us to the sub agent, subtask,
// sub background process that is waiting for?"
test('each thing the footer names jumps to where that work can be watched', async () => {
  launched = await launchApp()
  const { page } = launched
  await turnWithBackgroundAgents(page)

  const tile = page.locator('.tile').first()
  const footer = tile.locator('.turn-info').last()

  // the agent piece opens the Subagents panel ON that run
  await footer.locator('.turn-info-jump', { hasText: 'agent' }).click()
  await expect(tile.locator('.subagent-run').first()).toBeVisible({ timeout: 10_000 })
  await expect(
    tile.locator('.subagent-run').filter({ hasText: 'long haul research' })
  ).toBeVisible()

  // the Workflow piece opens Tasks instead
  await footer.locator('.turn-info-jump', { hasText: 'Workflow' }).click()
  await expect(tile.locator('.bgtasks-view')).toBeVisible({ timeout: 10_000 })
})

test('a Monitor is not pretending to be a link — it has no panel', async () => {
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
  await expect(footer).toContainText('Monitor')
  await expect(footer.locator('.turn-info-jump', { hasText: 'Monitor' })).toHaveCount(0)
})


// Angel: "after the sub process completed, the agent got me the result of it,
// however it kept saying waiting… I needed to send another message so it
// cleared". The transcript only learns a command finished if a later note names
// it, so a quiet exit left the footer stuck. Whether anything still holds the
// output file open is the real answer.
test('the footer clears itself once the command actually exits', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('just a turn with a background command')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // the fake agent's background command writes its log and exits, so nothing
  // holds the file open — the probe retires it WITHOUT another message. (The
  // Workflow it also emits has no file to probe and is scoped to the last turn.)
  const footer = page.locator('.tile .turn-info-waiting')
  await expect(footer).not.toContainText('background command', { timeout: 20_000 })
})

// Angel: "I think we removed the purple indicator for when something needs
// attention on the sidebar, I remember it was there + the bell icon". A session
// that finished a turn you have not read outranks one merely still working —
// the bell is asking you to look.
test('a finished-unseen session keeps its accent dot next to the bell', async () => {
  launched = await launchApp()
  const { page } = launched
  await turnWithBackgroundAgents(page)

  // make it "unseen": close the tile so the finish is not on screen
  await page.evaluate(async () => {
    const [s] = await window.hang4r.listSessions()
    const store = (
      window as unknown as { __hang4r_store: { getState(): { closeTile(id: string): void } } }
    ).__hang4r_store
    store.getState().closeTile(s.id)
  })
  await page.locator('.composer-input').first().waitFor({ state: 'detached' }).catch(() => {})

  const row = page.locator('.session-row').first()
  const dot = row.locator('.status-dot')
  const painted = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(painted).not.toBe('rgba(0, 0, 0, 0)')
})
