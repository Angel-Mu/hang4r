import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * SessionManager.prompt must claim the session atomically. Before the lock, two
 * prompts that reach main back to back on an IDLE session both passed the
 * (nonexistent) busy check — prompt() awaits before it ever flips the status —
 * and both were handed to the adapter: two user turns in flight at once.
 *
 * The realistic collision: the renderer auto-flushes a queued message the moment
 * a turn settles, while an external driver (hang4r CLI, phone) prompts on the
 * same idle edge.
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a queued-message flush and an external prompt on the same idle edge never double-drive', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('slow turn 1500')
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.composer-input')).toBeVisible({ timeout: 15_000 })
  const sessionId = await page.evaluate(
    () => window.hang4r.listSessions().then((l) => l[0].id)
  )

  // The external driver fires on the turn-complete EVENT. agent-event reaches the
  // renderer before the session-updated that triggers the store's queue flush,
  // and main has already flipped the session to idle by then — so the external
  // prompt reaches main first and the flush lands while that turn is running.
  await page.evaluate((sid) => {
    const w = window as unknown as { __ext?: { done: boolean; error: string | null } }
    w.__ext = { done: false, error: null }
    let fired = false
    window.hang4r.onAgentEvent((ev) => {
      if (fired || ev.sessionId !== sid || ev.event.kind !== 'turn-complete') return
      fired = true
      window.hang4r
        .prompt(sid, 'slow turn 600 EXTERNAL')
        .catch((e: unknown) => {
          w.__ext!.error = String(e)
        })
        .finally(() => {
          w.__ext!.done = true
        })
    })
  }, sessionId)

  // queue a UI message while the first turn is still running
  const composer = tile.locator('.composer-input')
  await composer.fill('QUEUED FROM UI')
  await composer.press('Enter')
  await expect(tile.locator('.queue-row')).toHaveCount(1)

  const sequence = async (): Promise<string[]> =>
    page.evaluate(
      (sid) =>
        window.hang4r.getSessionEvents(sid).then((evs) =>
          evs.flatMap((e) =>
            e.event.kind === 'user-text'
              ? [`user:${e.event.text}`]
              : e.event.kind === 'turn-complete'
                ? ['turn-complete']
                : []
          )
        ),
      sessionId
    )

  // all three turns finish (first, external, queued) — whichever way they ran
  await expect.poll(async () => (await sequence()).filter((s) => s === 'turn-complete').length, {
    timeout: 20_000
  }).toBe(3)
  await expect(tile.locator('.queue-row')).toHaveCount(0)

  // strictly one turn at a time: each user message is followed by its OWN
  // turn-complete before the next user message goes out
  expect(await sequence()).toEqual([
    'user:slow turn 1500',
    'turn-complete',
    'user:slow turn 600 EXTERNAL',
    'turn-complete',
    'user:QUEUED FROM UI',
    'turn-complete'
  ])
  // the external prompt won the race and was accepted
  const ext = await page.evaluate(
    () => (window as unknown as { __ext: { error: string | null } }).__ext
  )
  expect(ext.error).toBeNull()
})
