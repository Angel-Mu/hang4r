import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { makeScratchRepo, createProject } from './helpers'

/**
 * REAL-agent verification: runs the actual `claude` CLI (user's subscription,
 * haiku model, one cheap turn) through the full app. This is the test that
 * catches what the fake agent cannot: stream-json translation, block-key
 * merging, real timing, session rows.
 *
 * Opt-in (costs a few cents + needs a logged-in claude CLI):
 *   HANG4R_REAL_E2E=1 npx playwright test e2e/real-claude.spec.ts
 */
// fake-agent, runs in the normal suite: a session left 'running' when the app is
// killed must reset to idle on restart so the composer + Stop aren't stuck.
test('orphaned running session recovers on app restart', async () => {
  const udd = mkdtempSync(join(tmpdir(), 'hang4r-restart-'))
  const env = { ...process.env, HANG4R_FAKE_AGENT: '1', HANG4R_USER_DATA_DIR: udd, HANG4R_QUIET_TEST: '1' }
  const repo = makeScratchRepo()
  let app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${udd}`], env })
  let page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 20_000 })
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('ask permission to do a thing')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible({ timeout: 15_000 })
  await app.close() // app killed mid-turn — session left 'running' in the DB

  app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${udd}`], env })
  page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 20_000 })
  const after = (await page.evaluate(() => window.hang4r.listSessions()))[0]
  expect(after.status).toBe('idle')
  await app.close()
})

test.describe('real claude session', () => {
  test.skip(process.env.HANG4R_REAL_E2E !== '1', 'set HANG4R_REAL_E2E=1 to run')
  test.setTimeout(240_000)

  test('one real turn renders cleanly (no dup bubbles, no orphan blocks)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'hang4r-real-e2e-'))
    const app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, HANG4R_FAKE_AGENT: '0', HANG4R_USER_DATA_DIR: userDataDir, HANG4R_QUIET_TEST: '1' }
    })
    const page = await app.firstWindow()
    await page.waitForSelector('.app', { timeout: 20_000 })

    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    await page
      .locator('.dialog-prompt')
      .fill('Reply with exactly the word HANG4R_OK and nothing else.')
    // cheapest model (the Model select — after the Workspace select), in-place
    await page.locator('.dialog select').filter({ has: page.locator('option[value="haiku"]') }).selectOption('haiku')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()

    // The real reply streams in (session start loads hooks/skills — allow time).
    await expect(tile.locator('.msg-assistant')).toContainText('HANG4R_OK', {
      timeout: 180_000
    })

    // Regression assertions for the bugs the fake agent missed:
    // exactly ONE user bubble (no dup events), exactly ONE session row (no dup rows)
    await expect(tile.locator('.msg-user-card')).toHaveCount(1)
    await expect(page.locator('.session-row')).toHaveCount(1)
    // no empty orphaned assistant text blocks (the block-key mismatch symptom):
    const emptyBlocks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.msg-assistant')).filter(
        (el) => el.textContent?.trim() === ''
      ).length
    })
    expect(emptyBlocks).toBe(0)

    // Session settles to idle and cost is recorded.
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 60_000 })

    // Per-session context gauge populated from REAL usage (the whole point):
    // the composer ring shows a % (this is what only worked for the fake agent
    // before the message_start live-usage emit).
    await expect(tile.locator('.composer-ctx')).toBeVisible({ timeout: 10_000 })
    await expect(tile.locator('.composer-ctx')).toContainText('%')

    await page.screenshot({ path: 'test-results/real-claude.png', fullPage: true })

    // ---- Rewind: edit the sent message → conversation restarts from there ----
    // (real CC fork via --resume --resume-session-at --fork-session)
    const card = tile.locator('.msg-user-card').first()
    await card.hover()
    await card.locator('.msg-edit-btn').click()
    const editor = tile.locator('.msg-edit-input')
    await editor.fill('Reply with exactly the word HANG4R_REWOUND and nothing else.')
    await tile.getByRole('button', { name: 'Send from here' }).click()

    // the old turn is discarded; the edited prompt becomes the (only) user card
    await expect(tile.locator('.msg-assistant').last()).toContainText('HANG4R_REWOUND', {
      timeout: 180_000
    })
    await expect(tile.locator('.msg-user-card')).toHaveCount(1)
    await expect(tile.locator('.msg-user-card')).toContainText('HANG4R_REWOUND')
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 60_000 })

    await page.screenshot({ path: 'test-results/real-claude-rewind.png', fullPage: true })
    await app.close()
  })
})
