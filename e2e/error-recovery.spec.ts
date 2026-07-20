import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A turn that ends in error (Claude's error_during_execution) must not wedge the
 * session: the adapter is dropped so the NEXT prompt re-spawns clean. Angel hit
 * a session that kept erroring on every follow-up until he restarted the whole
 * app. The fake adapter emits a deterministic error turn on "trigger error".
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('an errored turn does not wedge the session — the next prompt recovers', async () => {
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
        title: 'error-recovery',
        firstPrompt: 'hello'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'error-recovery' }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // an errored turn → the session shows the error state
  await tile.locator('.composer-input').fill('please trigger error now')
  await tile.getByRole('button', { name: 'Send' }).click()
  await expect(tile.locator('.status-dot.status-error')).toBeVisible({ timeout: 15_000 })

  // the follow-up recovers: a fresh turn completes and the session is idle again
  await expect(tile.locator('.composer-input')).toBeEnabled()
  await tile.locator('.composer-input').fill('now do real work')
  await tile.getByRole('button', { name: 'Send' }).click()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  await expect(tile.locator('.msg-assistant').last()).toContainText('Working on it', {
    timeout: 15_000
  })
  // recovery is a normal turn — NOT re-imported as an external interactive-CLI turn
  await expect(tile.locator('.external-chip')).toHaveCount(0)
})
