import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The window cuts on a turn boundary: anywhere else and a tool-result loses the
 * tool_use it belongs to.
 */
test.describe('transcript window', () => {
  let launched: LaunchedApp | undefined
  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  test('a windowed load keeps whole turns', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await page.locator('.dialog-prompt').fill('turn 1')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id

    for (let i = 2; i <= 5; i++) {
      await page.evaluate(([id, n]) => window.hang4r.prompt(id as string, `turn ${n}`), [sid, i])
      await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    }

    const { full, windowed } = await page.evaluate(async (id) => ({
      full: await window.hang4r.getSessionEvents(id),
      windowed: await window.hang4r.getRecentSessionEvents(id, 2)
    }), sid)

    expect(windowed.truncated).toBe(true)
    expect(windowed.events.length).toBeLessThan(full.length)
    expect(windowed.events[0].event.kind).toBe('init')

    // the property the turn boundary exists to protect
    const toolUseIds = new Set(
      windowed.events
        .filter((e) => e.event.kind === 'block-final' && e.event.block?.type === 'tool_use')
        .map((e) => e.event.block.id)
    )
    const orphans = windowed.events
      .filter((e) => e.event.kind === 'tool-result')
      .map((e) => e.event.toolUseId)
      .filter((id: string) => !toolUseIds.has(id))
    expect(orphans).toEqual([])
  })

  test('the conversation offers the turns it left on disk', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.evaluate(() => window.hang4r.setSetting('openTurns', '1'))
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await page.locator('.dialog-prompt').fill('turn 1')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
    for (const n of [2, 3, 4]) {
      await page.evaluate(([id, t]) => window.hang4r.prompt(id as string, `turn ${t}`), [sid, n])
      await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    }

    // reopen so the window applies to a replayed transcript, not a live one
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.session-row').first().click()
    const earlier = tile.locator('.chat-load-earlier')
    await expect(earlier).toBeVisible({ timeout: 20_000 })

    const windowed = await tile.locator('.chat-unit').count()
    await earlier.click()
    await expect(earlier).toBeHidden({ timeout: 20_000 })
    expect(await tile.locator('.chat-unit').count()).toBeGreaterThan(windowed)
  })
})
