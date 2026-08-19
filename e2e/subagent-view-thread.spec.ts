import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Regression for Angel's screenshot bug: clicking "⤷ View thread" on an Agent
 * (subagent) row in chat did nothing useful — with the Subagents panel collapsed
 * it opened the panel but never surfaced the specific run you clicked. The signal
 * carried no thread id, so the clicked run was never focused.
 *
 * The fix threads the clicked run's toolUseId through openSubagents → the
 * SubagentInspector expands + scrolls-to + flashes the matching run. This test
 * reproduces the exact scenario (run collapsed, whole panel closed) and asserts
 * the ⤷ path both OPENS the panel and EXPANDS the targeted run.
 */
test.describe('subagent ⤷ View thread', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('⤷ View thread opens the collapsed Subagents panel and jumps to that run', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // Start a session; the fake agent runs one turn that spawns an `Agent`
    // (subagent) tool call, so the chat gets an agent row with a ⤷ button.
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('view thread test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Reproduce Angel's state: open Subagents, COLLAPSE the run, then CLOSE the
    // whole panel. Collapse persists in the renderer's collapsedRuns map, so on
    // reopen the run starts collapsed — making the expand below discriminating.
    await tile.getByRole('button', { name: 'Subagents' }).click()
    const run = () => tile.locator('.subagent-run').first()
    await expect(run().locator('.subagent-run-body')).toBeVisible() // expanded by default
    await run().locator('.subagent-run-header').click()
    await expect(run().locator('.subagent-run-body')).toHaveCount(0) // collapsed
    // clicking the active tab toggles the panel shut
    await tile.getByRole('button', { name: 'Subagents' }).click()
    await expect(tile.locator('.context-panel')).toHaveCount(0)

    // The fix: click ⤷ "View thread" on the agent row in chat.
    const viewThread = tile.locator('.tool-row-action', { hasText: 'View thread' }).first()
    await expect(viewThread).toBeVisible()
    await viewThread.click()

    // Panel opens to Subagents (pre-existing behavior)…
    await expect(tile.locator('.subagents-view')).toBeVisible()
    // …AND the targeted run is expanded again — this is the fix. Without the
    // toolUseId focus, the reopened run would stay collapsed (body absent).
    await expect(run().locator('.subagent-run-body')).toBeVisible()
  })
})
