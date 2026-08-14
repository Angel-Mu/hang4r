import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * "Surface the real error": the CLI reports failures as an opaque
 * `error_during_execution`, but the real reason lives in its stderr. The adapter
 * now classifies the error into a short label and attaches the raw stderr/result
 * detail; the transcript shows the label and reveals the detail in an expandable
 * disclosure. The fake adapter emits a 529/overloaded stderr on "trigger error".
 *
 * The MOST COMMON case leaves EMPTY stderr — the turn was killed mid-command by a
 * session restart / external "⇄ interactive CLI" driver — so the classifier can
 * only reach the generic "The CLI errored". hang4r knows better: the jsonl tail is
 * POISONED (a dangling tool_use), so sessionManager relabels it "Interrupted
 * mid-command — recovered on next turn". Second test proves that, and that a
 * specific 529 stderr still wins.
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('an errored turn shows a classified label + expandable raw detail', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'surface-error',
        firstPrompt: 'hello'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'surface-error' }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // drive the error turn
  await tile.locator('.composer-input').fill('please trigger error now')
  await tile.getByRole('button', { name: 'Send' }).click()
  await expect(tile.locator('.status-dot.status-error')).toBeVisible({ timeout: 15_000 })

  // the transcript row's SUMMARY shows the CLASSIFIED label, NOT the opaque
  // catch-all (which is tucked into the collapsed detail instead)
  const errorRow = tile.locator('.turn-info-error-expandable')
  const summary = errorRow.locator('summary')
  await expect(summary).toContainText('Claude API overloaded (529)')
  await expect(summary).not.toContainText('error_during_execution')

  // the raw detail is collapsed by default, then revealed on click
  const detail = tile.locator('.turn-error-detail')
  await expect(detail).toBeHidden()
  await errorRow.locator('summary').click()
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('overloaded_error')
  await expect(detail).toContainText('error_during_execution')
})

test('an opaque error on a POISONED tail shows the interrupted label, not the catch-all', async () => {
  // a temp claude-history root the fake adapter drops a poisoned transcript into,
  // so ClaudeImport.tailIsPoisoned resolves without touching the real ~/.claude
  const claudeRoot = mkdtempSync(join(tmpdir(), 'hang4r-claude-'))
  launched = await launchApp({ env: { HANG4R_CLAUDE_PROJECTS_DIR: claudeRoot } })
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'opaque-interrupt',
        firstPrompt: 'hello'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'opaque-interrupt' }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // drive an OPAQUE error (empty stderr) that also poisons the jsonl tail — the
  // signature of a turn killed mid-command by an external driver
  await tile.locator('.composer-input').fill('please trigger opaque interrupt now')
  await tile.getByRole('button', { name: 'Send' }).click()
  await expect(tile.locator('.status-dot.status-error')).toBeVisible({ timeout: 15_000 })

  // the summary shows the reassuring, hang4r-derived label — NOT the scary
  // catch-all the classifier would produce from the empty stderr alone
  const errorRow = tile.locator('.turn-info-error-expandable')
  const summary = errorRow.locator('summary')
  await expect(summary).toContainText('Interrupted mid-command — recovered on next turn')
  await expect(summary).not.toContainText('The CLI errored')

  // the raw opaque detail is still preserved behind the disclosure
  await errorRow.locator('summary').click()
  await expect(tile.locator('.turn-error-detail')).toContainText('error_during_execution')
})
