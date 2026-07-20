import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Configurable notifications + the sidebar "needs you" badge (round 11 ②③).
 * Both read the same isAwaitingPermission predicate (src/renderer/src/state/store.ts),
 * so this suite proves the row badge, the collapsed-workspace count chip, and
 * the underlying transcript state all move together.
 */
test.describe('action-required badge', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  test('permission-wait shows the row badge and collapsed workspace count chip; resolving clears both', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('ask permission for a thing') // fake agent: stays running
    await page.getByRole('button', { name: /Start agent/ }).click()

    const permCard = page.locator('.permission-card')
    await expect(permCard).toBeVisible({ timeout: 20_000 })

    // row: pulsing amber dot (pre-existing) AND the new unmissable badge
    await expect(page.locator('.session-row .status-dot.status-awaiting')).toBeVisible()
    await expect(page.locator('.session-row .session-flag-action')).toBeVisible()
    await expect(page.locator('.session-row .session-flag-error')).toHaveCount(0)

    // collapse the workspace — the row disappears but the count chip on the
    // header must still surface it (badge truth doesn't hide with the list)
    await page.locator('.project-folder').first().click()
    await expect(page.locator('.session-row')).toHaveCount(0)
    const chip = page.locator('.project-flag-action')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('1')
    await expect(page.locator('.project-flag-error')).toHaveCount(0)

    // resolve the permission from the still-open tile (sidebar collapse
    // doesn't affect the open pane) — both indicators clear
    await permCard.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(page.locator('.project-flag-action')).toHaveCount(0)

    await page.locator('.project-folder').first().click() // expand again
    await expect(page.locator('.session-row .session-flag-action')).toHaveCount(0)
    await expect(page.locator('.session-row .status-dot.status-awaiting')).toHaveCount(0)
  })

  test('the badge stays visible even when its OS notification is muted', async () => {
    // config controls the OS Notification only, not the sidebar's truth —
    // mute notifications.onActionRequired in the app file BEFORE launch and
    // confirm the badge still renders.
    launched = await launchApp()
    const { page, userDataDir } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    mkdirSync(join(userDataDir, '.hang4r'), { recursive: true })
    writeFileSync(
      join(userDataDir, '.hang4r', 'settings.json'),
      JSON.stringify({ notifications: { onActionRequired: false } }, null, 2)
    )
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('ask permission for a thing')
    await page.getByRole('button', { name: /Start agent/ }).click()

    await expect(page.locator('.permission-card')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.session-row .session-flag-action')).toBeVisible()
  })
})

test.describe('notifications settings', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  test('notifications.onActionRequired flips via Settings UI and persists to the app settings.json file', async () => {
    launched = await launchApp()
    const { page, userDataDir } = launched
    await page.waitForSelector('.app')

    await page.keyboard.press('Meta+,')
    await page.waitForSelector('.settings-page')
    const row = page.locator('.notify-toggle', { hasText: 'Notify when a session needs your approval' })
    const checkbox = row.locator('input[type="checkbox"]')
    await expect(checkbox).toBeChecked() // default ON
    await checkbox.uncheck()
    await page.locator('.settings-footer').getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.settings-saved')).toBeVisible()

    const appFile = join(userDataDir, '.hang4r', 'settings.json')
    const parsed = JSON.parse(readFileSync(appFile, 'utf8'))
    expect(parsed.notifications.onActionRequired).toBe(false)

    // resolves through the same flat getSetting IPC every consumer uses
    const resolved = await page.evaluate(() => window.hang4r.getSetting('notifications.onActionRequired'))
    expect(resolved).toBe('off')
  })

  test('a workspace settings.json override wins over the app default for that project', async () => {
    launched = await launchApp()
    const { page, userDataDir } = launched
    const repo = makeScratchRepo()
    const { id } = await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // app default: off
    writeFileSync(
      join(userDataDir, '.hang4r', 'settings.json'),
      JSON.stringify({ notifications: { onActionRequired: false } }, null, 2)
    )
    // this project overrides it back on
    mkdirSync(join(repo, '.hang4r'), { recursive: true })
    writeFileSync(
      join(repo, '.hang4r', 'settings.json'),
      JSON.stringify({ notifications: { onActionRequired: true } }, null, 2)
    )

    const resolved = await page.evaluate(async (projectId) => {
      return {
        app: await window.hang4r.getSetting('notifications.onActionRequired'),
        ws: await window.hang4r.getSetting(`notifications.onActionRequired:${projectId}`)
      }
    }, id)
    expect(resolved.app).toBe('off')
    expect(resolved.ws).toBe('on') // workspace beats app, same routing settings.resolve() uses
  })
})
