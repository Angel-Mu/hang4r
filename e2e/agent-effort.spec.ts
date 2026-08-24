import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Reasoning effort is a real CLI lever (claude `--effort`, codex
 * `model_reasoning_effort`), and ultracode is a real claude setting — both were
 * only reachable mid-session. They must be settable when the agent STARTS, and
 * default per agent from settings.
 *
 * Effort is stamped onto the session at birth rather than resolved at each
 * spawn, so these assertions read the session's own stored value.
 */
test.describe('agent reasoning effort', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  const openDialog = async (page: LaunchedApp['page']): Promise<void> => {
    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await expect(page.locator('.dialog')).toBeVisible()
  }

  const startedSession = async (
    page: LaunchedApp['page']
  ): Promise<{ id: string; effort: string | null; ultracode: boolean }> => {
    await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
    await expect(page.locator('.dialog')).toBeHidden()
    return page.evaluate(async () => {
      const [s] = await window.hang4r.listSessions()
      return {
        id: s.id,
        effort: await window.hang4r.getSessionEffort(s.id),
        ultracode: await window.hang4r.getSessionUltracode(s.id)
      }
    })
  }

  test('the dialog sets the new session’s effort', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')

    await openDialog(page)
    const effortSelect = page.locator('.field-model-row select.field-effort')
    await expect(effortSelect).toHaveValue('')
    await effortSelect.selectOption('high')

    expect(await startedSession(page)).toMatchObject({ effort: 'high', ultracode: false })
  })

  test('agents.<backend>.effort pre-fills the dialog and stamps an untouched session', async () => {
    launched = await launchApp()
    const { page, userDataDir } = launched
    await createProject(page, makeScratchRepo())
    writeFileSync(
      join(userDataDir, '.hang4r', 'settings.json'),
      JSON.stringify({ agents: { claude: { effort: 'xhigh' }, codex: { effort: 'low' } } }, null, 2)
    )
    await page.reload()
    await page.waitForSelector('.app')

    await openDialog(page)
    const effortSelect = page.locator('.field-model-row select.field-effort')
    await expect(effortSelect).toHaveValue('xhigh')

    // switching backend re-resolves to THAT agent's default
    await page.locator('.dialog .segmented button', { hasText: 'Codex' }).click()
    await expect(effortSelect).toHaveValue('low')
    await page.locator('.dialog .segmented button', { hasText: 'Claude Code' }).click()
    await expect(effortSelect).toHaveValue('xhigh')

    expect(await startedSession(page)).toMatchObject({ effort: 'xhigh' })
  })

  // codex's model_reasoning_effort tops out at 'high' and adds 'minimal'. The
  // shared chip list used to offer claude's xhigh/max on codex, where they
  // silently clamped, while hiding the one level codex has and claude doesn't.
  test('codex is offered only the levels it accepts', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')

    await openDialog(page)
    await page.locator('.dialog .segmented button', { hasText: 'Codex' }).click()
    const values = await page
      .locator('.field-model-row select.field-effort option')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
    expect(values).toEqual(['', 'minimal', 'low', 'medium', 'high'])
  })

  test('ultracode is claude-only, and starts the session with it on', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')

    await openDialog(page)
    const ultra = page.locator('.dialog .dialog-check input[type=checkbox]')
    await expect(ultra).toBeVisible()
    await page.locator('.dialog .segmented button', { hasText: 'Codex' }).click()
    await expect(ultra).toHaveCount(0)
    await page.locator('.dialog .segmented button', { hasText: 'Claude Code' }).click()

    await ultra.check()
    // ultracode pins the session to xhigh, so the effort control stands down
    await expect(page.locator('.field-model-row select.field-effort')).toBeDisabled()

    expect(await startedSession(page)).toMatchObject({ ultracode: true })
  })

  test('the in-session model menu toggles ultracode', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')

    await openDialog(page)
    const { id } = await startedSession(page)
    const tile = page.locator('.tile').first()
    await tile.locator('.status-dot.status-idle').first().waitFor({ timeout: 20_000 })
    await tile.locator('.model-picker-trigger').click()
    await tile.locator('.model-menu-ultra input[type=checkbox]').check()
    await expect(tile.locator('.model-picker-effort')).toContainText('Ultracode')

    await expect
      .poll(() => page.evaluate((sid) => window.hang4r.getSessionUltracode(sid), id))
      .toBe(true)
  })
})
