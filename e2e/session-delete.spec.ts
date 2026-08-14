import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Permanent Delete (v1.0.98): the session menu offers "Delete permanently…" and
 * the IPC actually drops the session + its events from the DB (archive only hid
 * it). Angel needed this to remove a wedged session himself instead of editing
 * the database. The confirm dialog is store-level; here we assert the menu wiring
 * and the delete EFFECT via the IPC (the confirm path is exercised in-app).
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a session can be deleted permanently — menu item present, and it leaves the DB', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('delete-me')
  await page.getByRole('button', { name: /Start agent/ }).click()
  const tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  const id: string = await page.evaluate(
    () =>
      (window as unknown as { __hang4r_store: { getState(): { focusedSessionId: string } } })
        .__hang4r_store.getState().focusedSessionId
  )
  expect(id).toBeTruthy()

  // it exists in the persisted list
  const listIds = (): Promise<string[]> =>
    page.evaluate(() => window.hang4r.listSessions().then((l) => l.map((s) => s.id)))
  expect(await listIds()).toContain(id)

  // the session menu wires "Delete permanently…"
  await page.locator('.session-row', { hasText: 'delete-me' }).click({ button: 'right' })
  await expect(
    page.locator('.ctx-menu .ctx-item', { hasText: 'Delete permanently' })
  ).toBeVisible()
  await page.keyboard.press('Escape')

  // the delete EFFECT: IPC removes it from the DB entirely
  await page.evaluate((sid) => window.hang4r.deleteSession(sid), id)
  await expect.poll(listIds, { timeout: 10_000 }).not.toContain(id)
})
