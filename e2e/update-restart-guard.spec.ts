import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel, Aug 24 (v1.0.114): clicked the "Restart to update" pill while an agent
 * was mid-turn — the app relaunched with no prompt and the turn was lost.
 *
 * `before-quit` had the only guard, and `autoUpdater.quitAndInstall()` tears the
 * app down without ever routing through `app.quit()`, so the guard never saw it.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  // these tests ARM the guard, so the teardown's own quit hits it too — answer
  // that confirm or app.close() waits forever on a dialog nobody clicks
  await launched?.page
    .evaluate(() => window.hang4r.onQuitConfirm(() => void window.hang4r.answerQuitConfirm(true)))
    .catch(() => {})
  await launched?.app.close().catch(() => {})
  launched = null
})

/** Start an agent that stays 'running' (the fake agent parks on a permission ask). */
async function runningSession(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('ask permission to do a thing')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible({ timeout: 15_000 })
}

test('the update restart asks first while an agent is working, and Cancel keeps the session', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  await runningSession(page)

  // click the real pill's action; it must NOT resolve into a restart unasked
  const install = page.evaluate(() => window.hang4r.installUpdate())

  const dialog = page.locator('.quit-dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog.locator('.quit-title')).toHaveText('Restart to update?')
  await expect(dialog.locator('.quit-go')).toContainText('Restart')
  await expect(dialog.locator('.quit-message')).toContainText('An agent is still working')

  await dialog.locator('.quit-cancel').click()
  await install

  // still here, still working — nothing was interrupted
  await expect(page.locator('.app')).toBeVisible()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible()
})

test('Esc on the update confirm is Cancel, not Restart', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  await runningSession(page)

  const install = page.evaluate(() => window.hang4r.installUpdate())
  await expect(page.locator('.quit-dialog')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape')
  await install
  await expect(page.locator('.quit-dialog')).toBeHidden()
  await expect(page.locator('.tile .status-dot.status-running')).toBeVisible()
})

// With nothing live there is nothing to lose, so the pill must stay a one-click
// restart. This test ends by letting the install proceed — hence last.
test('with no agent running, the restart is not gated', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  void page.evaluate(() => window.hang4r.installUpdate()).catch(() => {})
  await expect(page.locator('.quit-dialog')).toHaveCount(0, { timeout: 3_000 })
})

/**
 * Angel: "the agent was working but I installed the new version and didnt prompt
 * me, it got interrupted".
 *
 * The confirm dialog only guards quits that REACH it. electron-updater also
 * stages an update to apply on the NEXT quit of any kind — a crash, a force
 * quit, a logout — none of which ask anything. That flag is now held off while
 * work is live, so the worst case is an update that waits.
 */
test('a staged update is not armed to apply while an agent is working', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  await runningSession(page)

  // downloaded + armed means it would apply on ANY quit, guarded or not
  await expect
    .poll(
      async () => {
        const st = await page.evaluate(() => window.hang4r.getUpdateStatus())
        return st.state === 'downloaded' ? st.armedForQuit : 'not-downloaded'
      },
      { timeout: 20_000, intervals: [500] }
    )
    .not.toBe(true)
})
