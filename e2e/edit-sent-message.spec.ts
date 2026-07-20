// Edit-a-sent-message parity across backends. Pure decision helpers (unit) +
// the two fake-agent flows that PROVE the honest semantics: Cursor resends as a
// NEW turn (append — earlier messages stay), Codex truncates in place (real
// rollback). The Claude fork is a real-CLI concern (needs a live jsonl) and is
// covered by e2e/real-claude.spec.ts + the UI-only check in session-flow.spec.ts.
import { expect, test, type Page } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'
import {
  rewindStrategyFor,
  rewindDiscardsHistory,
  turnsToRewind
} from '../src/main/services/rewindStrategy'

const SHOTS =
  '/private/tmp/claude-501/-Users-angel-xmu-Documents-claude-agentic-ide/50d9fca6-6e52-45e6-a35d-42793d8a7e55/scratchpad'

/* ---------------- pure decision helpers ---------------- */

test.describe('rewind strategy (per-backend honesty)', () => {
  test('claude forks, codex rolls back, cursor appends', () => {
    expect(rewindStrategyFor('claude')).toBe('fork')
    expect(rewindStrategyFor('codex')).toBe('rollback')
    expect(rewindStrategyFor('cursor')).toBe('append')
  })

  test('only fork/rollback discard history; append keeps it', () => {
    expect(rewindDiscardsHistory('fork')).toBe(true)
    expect(rewindDiscardsHistory('rollback')).toBe(true)
    expect(rewindDiscardsHistory('append')).toBe(false)
  })

  test('turnsToRewind counts every user turn from the edited one to the end', () => {
    // user-text events at store seqs 2, 5, 9 (three turns)
    const userSeqs = [2, 5, 9]
    expect(turnsToRewind(userSeqs, 9)).toBe(1) // edit the last → drop 1
    expect(turnsToRewind(userSeqs, 5)).toBe(2) // edit the middle → drop it + the last
    expect(turnsToRewind(userSeqs, 2)).toBe(3) // edit the first → drop all
    expect(turnsToRewind(userSeqs, 99)).toBe(0) // nothing at/after → nothing to drop
  })
})

/* ---------------- fake-agent flows ---------------- */

/** Open the New Agent dialog on the first project and start a session on the
 *  given backend, in place, with `firstPrompt`. Returns the first tile. */
async function startSession(page: Page, backendLabel: string, firstPrompt: string) {
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog .segmented button', { hasText: backendLabel }).click()
  await page.locator('.dialog .segmented button', { hasText: 'In-place' }).click()
  await page.locator('.dialog-prompt').fill(firstPrompt)
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  return tile
}

/** Send a follow-up prompt through the composer and wait for idle. */
async function followUp(tile: ReturnType<Page['locator']>, text: string) {
  await tile.locator('.composer-input').fill(text)
  await tile.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
}

test.describe('edit a sent message — honest per-backend resend', () => {
  let launched: LaunchedApp | undefined
  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  test('Cursor: editing resends as a NEW turn (append) — earlier messages stay', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')

    const tile = await startSession(page, 'Cursor', 'first message alpha')
    await followUp(tile, 'second message beta')
    await expect(tile.locator('.msg-user-card')).toHaveCount(2)

    // edit the FIRST message
    const first = tile.locator('.msg-user-card').first()
    await first.hover()
    await first.locator('.msg-edit-btn').click()
    // honest copy: append, not rewind
    await expect(tile.getByRole('button', { name: 'Resend as new turn' })).toBeVisible()
    await expect(tile.locator('.msg-edit-hint')).toContainText('as a new turn')
    await tile.locator('.msg-edit-input').fill('edited first gamma')
    await page.screenshot({ path: `${SHOTS}/cursor-resend-editor.png`, fullPage: true })
    await tile.getByRole('button', { name: 'Resend as new turn' }).click()

    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // APPEND semantics: nothing erased — the two originals stay AND the edited
    // text lands as a third, newest user turn.
    await expect(tile.locator('.msg-user-card')).toHaveCount(3)
    await expect(tile.locator('.msg-user-card').nth(0)).toContainText('first message alpha')
    await expect(tile.locator('.msg-user-card').nth(1)).toContainText('second message beta')
    await expect(tile.locator('.msg-user-card').last()).toContainText('edited first gamma')
    await page.screenshot({ path: `${SHOTS}/cursor-resend-result.png`, fullPage: true })
  })

  test('Codex: editing truncates in place (real rollback) — later messages discarded', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')

    const tile = await startSession(page, 'Codex', 'first message alpha')
    await followUp(tile, 'second message beta')
    await expect(tile.locator('.msg-user-card')).toHaveCount(2)

    // edit the FIRST message — Codex forks/rolls back, so the copy is the true one
    const first = tile.locator('.msg-user-card').first()
    await first.hover()
    await first.locator('.msg-edit-btn').click()
    await expect(tile.getByRole('button', { name: 'Send from here' })).toBeVisible()
    await expect(tile.locator('.msg-edit-hint')).toContainText('later messages are discarded')
    await tile.locator('.msg-edit-input').fill('edited first gamma')
    await tile.getByRole('button', { name: 'Send from here' }).click()

    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // TRUNCATE semantics: the edited message becomes the only user turn; the
    // second message is gone from the transcript.
    await expect(tile.locator('.msg-user-card')).toHaveCount(1)
    await expect(tile.locator('.msg-user-card')).toContainText('edited first gamma')
    await expect(tile.locator('.msg-user-card')).not.toContainText('second message beta')
    await page.screenshot({ path: `${SHOTS}/codex-rollback-result.png`, fullPage: true })
  })
})
