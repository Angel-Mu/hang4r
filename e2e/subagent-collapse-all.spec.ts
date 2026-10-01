import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Threads own their open state so "View thread" can expand one without
 * re-rendering the panel, which is why a bulk toggle needs its own signal.
 */
test.describe('collapse all subagents', () => {
  let launched: LaunchedApp | undefined
  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  test('one control collapses every thread, and the choice survives a restart', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('spawn background agents')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Subagents' }).click()

    const runs = tile.locator('.subagent-run')
    const bodies = tile.locator('.subagent-run-body')
    await expect(runs.first()).toBeVisible({ timeout: 10_000 })
    const total = await runs.count()
    expect(total).toBeGreaterThan(1)
    await expect(bodies).toHaveCount(total)

    const toggle = tile.locator('.subagents-collapse-all')
    await expect(toggle).toHaveText('Collapse all')
    await toggle.click()
    await expect(bodies).toHaveCount(0)
    await expect(toggle).toHaveText('Expand all')

    await toggle.click()
    await expect(bodies).toHaveCount(total)
    await expect(toggle).toHaveText('Collapse all')

    // collapsed threads are remembered the way a single manual collapse is
    await toggle.click()
    await expect(bodies).toHaveCount(0)
    await page.reload()
    await page.waitForSelector('.app')
    // the Subagents tab is still the active one after a reload (session UI
    // persists), so clicking it again would close the panel
    if ((await tile.locator('.subagents-view').count()) === 0) {
      await tile.getByRole('button', { name: 'Subagents' }).click()
    }
    // the runs must come BACK, or a count of zero would satisfy the assertion
    // below without proving anything
    await expect(tile.locator('.subagent-run')).toHaveCount(total, { timeout: 15_000 })
    await expect(tile.locator('.subagent-run-body')).toHaveCount(0)
  })
})
