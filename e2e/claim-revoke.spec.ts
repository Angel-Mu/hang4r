import { test, expect, type Page } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'
import { SESSION_BUSY_MARKER } from '../src/shared/sessionBusy'

/**
 * A turn claim (status 'starting') spans awaits (resyncExternal, ensureWorkdir).
 * Stop / archive / hand-off during that window must REVOKE the claim: a status
 * check alone can't tell "my claim" from "the next claimer's", so the first
 * claimer used to wake up, spawn a second adapter and prompt it as well.
 * rewind used to skip the lock entirely and call adapter.prompt directly.
 *
 * HANG4R_TEST_WORKDIR_DELAY_MS stretches ensureWorkdir (fake agent only) so the
 * window is wide enough to hit on purpose.
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function startSession(page: Page, backendLabel: string, firstPrompt: string): Promise<string> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog .segmented button', { hasText: backendLabel }).click()
  await page.locator('.dialog .segmented button', { hasText: 'In-place' }).click()
  await page.locator('.dialog-prompt').fill(firstPrompt)
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 30_000 })
  return page.evaluate(() => window.hang4r.listSessions().then((l) => l[0].id))
}

const userTexts = (page: Page, sid: string): Promise<string[]> =>
  page.evaluate(
    (id) =>
      window.hang4r
        .getSessionEvents(id)
        .then((evs) => evs.flatMap((e) => (e.event.kind === 'user-text' ? [e.event.text] : []))),
    sid
  )

test('Stop during a claim revokes it: the first claimer must not spawn or prompt', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_WORKDIR_DELAY_MS: '1200' } })
  const { page } = launched
  const sid = await startSession(page, 'Claude', 'slow turn 100 FIRST')
  // no adapter, idle: the state a ctl send finds after a hand-off / restart
  await page.evaluate((id) => window.hang4r.releaseForExternal(id), sid)

  const result = await page.evaluate(async (id) => {
    const out: { a: string; b: string } = { a: 'pending', b: 'pending' }
    const settle = (p: Promise<unknown>, k: 'a' | 'b'): Promise<void> =>
      p.then(
        () => void (out[k] = 'ok'),
        (e: unknown) => void (out[k] = String(e))
      )
    const pa = settle(window.hang4r.prompt(id, 'slow turn 400 A-CLAIMED-THEN-STOPPED'), 'a')
    await new Promise((r) => setTimeout(r, 300)) // A is parked in ensureWorkdir
    await window.hang4r.interrupt(id) // Stop: session -> idle, A's claim is void
    const pb = settle(window.hang4r.prompt(id, 'slow turn 400 B'), 'b') // legit second claimer
    await Promise.all([pa, pb])
    return out
  }, sid)

  await expect
    .poll(async () => (await userTexts(page, sid)).includes('slow turn 400 B'), { timeout: 15_000 })
    .toBe(true)
  await page.waitForTimeout(1500) // let a wrongly-resumed A show itself
  expect(await userTexts(page, sid)).toEqual(['slow turn 100 FIRST', 'slow turn 400 B'])
  expect(result.a).not.toBe('ok') // A was told it did not start
  expect(result.b).toBe('ok')
})

test('rewind takes the lock: a prompt arriving mid-rewind is rejected busy, never double-driven', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_WORKDIR_DELAY_MS: '1200' } })
  const { page } = launched
  const sid = await startSession(page, 'Codex', 'slow turn 100 original')
  await page.evaluate((id) => window.hang4r.releaseForExternal(id), sid) // no adapter -> rewind must respawn

  const result = await page.evaluate(async (id) => {
    const out: { rewind: string; other: string } = { rewind: 'pending', other: 'pending' }
    const pr = window.hang4r
      .rewindSession(id, 'slow turn 100 original', 0, 'slow turn 1500 EDITED')
      .then(
        () => void (out.rewind = 'ok'),
        (e: unknown) => void (out.rewind = String(e))
      )
    await new Promise((r) => setTimeout(r, 300)) // rewind is parked in ensureAdapter
    const po = window.hang4r.prompt(id, 'slow turn 400 INTRUDER').then(
      () => void (out.other = 'ok'),
      (e: unknown) => void (out.other = String(e))
    )
    await Promise.all([pr, po])
    return out
  }, sid)

  await page.waitForTimeout(2500)
  expect(result.rewind).toBe('ok')
  expect(result.other).toContain(SESSION_BUSY_MARKER)
  expect(await userTexts(page, sid)).toEqual(['slow turn 1500 EDITED'])
})
