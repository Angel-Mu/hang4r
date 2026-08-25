import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: the dialog told him something was running but gave him nothing to do
 * about it — cancel, hunt the session down, press Stop, quit again. Worse for a
 * turn stuck on a stalled subagent, where the prompt would just keep coming back.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.page
    .evaluate(() => window.hang4r.onQuitConfirm(() => void window.hang4r.answerQuitConfirm(true)))
    .catch(() => {})
  await launched?.app.close().catch(() => {})
  launched = null
})

async function workingAgent(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('ask permission to do a thing')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible({ timeout: 15_000 })
}

test('the dialog lists what is running and stops it in place', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  await workingAgent(page)

  void page.evaluate(() => window.hang4r.installUpdate()).catch(() => {})
  const dialog = page.locator('.quit-dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })

  // the working agent is a row, not just a sentence
  const row = dialog.locator('.quit-live-row')
  await expect(row).toHaveCount(1)
  await expect(row.locator('.quit-live-kind')).toHaveText('agent working')

  // stopping it from the dialog really interrupts the turn
  await row.locator('.quit-live-stop').click()
  await expect(dialog.locator('.quit-live-row')).toHaveCount(0)
  await expect(dialog.locator('.quit-message')).toHaveText('Nothing is running any more.')
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 15_000 })

  // and the dialog is still up, so the restart is one click away
  await expect(dialog.locator('.quit-cancel')).toBeVisible()
})

test('cancel still leaves everything alone', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  await workingAgent(page)

  void page.evaluate(() => window.hang4r.installUpdate()).catch(() => {})
  const dialog = page.locator('.quit-dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog.locator('.quit-live-row')).toHaveCount(1)
  await dialog.locator('.quit-cancel').click()

  await expect(dialog).toBeHidden()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible()
})
