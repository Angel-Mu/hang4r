import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * "Surface the real error": the CLI reports failures as an opaque
 * `error_during_execution`, but the real reason lives in its stderr. The adapter
 * now classifies the error into a short label and attaches the raw stderr/result
 * detail; the transcript shows the label and reveals the detail in an expandable
 * disclosure. The fake adapter emits a 529/overloaded stderr on "trigger error".
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
