import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { makeScratchRepo, createProject } from './helpers'

/**
 * Angel, on the fix shipped in v1.0.137: "I dont think so, at least the blue dot
 * indicator is not [working]".
 *
 * His sessions are days old, so the scenario is an APP RESTART — the transcript
 * comes back from disk carrying async-agent launches whose process died long
 * ago. The earlier test only covered a re-spawn inside one app run, which is a
 * different path: this one closes the app and reopens it.
 */
test('a restored session does not claim agents from a process that is gone', async () => {
  const udd = mkdtempSync(join(tmpdir(), 'hang4r-dot-'))
  const env = {
    ...process.env,
    HANG4R_FAKE_AGENT: '1',
    HANG4R_USER_DATA_DIR: udd,
    HANG4R_QUIET_TEST: '1'
  }
  const repo = makeScratchRepo()

  let app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${udd}`], env })
  let page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 20_000 })
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('spawn background agents')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  // while the launching process is alive, the claim is correct
  await expect(page.locator('.session-row .status-dot.status-pending')).toHaveCount(1)
  await app.close()

  // reopen: the CLI process that launched those agents no longer exists
  app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${udd}`], env })
  page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.locator('.session-row').first().click()
  await page.locator('.tile').first().waitFor({ timeout: 20_000 })

  await expect
    .poll(() => page.locator('.session-row .status-dot.status-pending').count(), {
      timeout: 15_000
    })
    .toBe(0)
  await app.close()
})
