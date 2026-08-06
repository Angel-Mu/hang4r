import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, type LaunchedApp } from './helpers'

/**
 * Settings → Models has a PER-AGENT default model (each agent defines its own
 * models — Angel). The Claude / Codex / Cursor dropdowns write agents.<backend>
 * .model, the SAME path resolveAgentDefault reads when a new session picks its
 * default model.
 */
test('per-agent default model persists to agents.<backend>.model and resolves', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page, userDataDir } = launched
  try {
    await page.waitForSelector('.app')
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('.settings-page')
    await page.locator('.settings-nav-item', { hasText: 'Models' }).click()

    // three per-agent default-model fields (not a single "Default model")
    await expect(
      page.locator('.settings-field', { hasText: 'Claude Code default model' })
    ).toBeVisible()
    await expect(page.locator('.settings-field', { hasText: 'Codex default model' })).toBeVisible()
    await expect(page.locator('.settings-field', { hasText: 'Cursor default model' })).toBeVisible()

    // pick a Claude default (a stable static option) and save
    const claudeSelect = page
      .locator('.settings-field', { hasText: 'Claude Code default model' })
      .locator('select')
    await claudeSelect.selectOption('sonnet')
    await page.locator('.settings-footer').getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.settings-saved')).toBeVisible()

    // written to agents.claude.model in the app settings.json
    const appFile = join(userDataDir, '.hang4r', 'settings.json')
    const parsed = JSON.parse(readFileSync(appFile, 'utf8'))
    expect(parsed.agents.claude.model).toBe('sonnet')

    // and resolvable as the new-session default (the path NewSessionDialog reads)
    const resolved = await page.evaluate(() =>
      window.hang4r.resolveAgentDefault('claude', 'model', undefined)
    )
    expect(resolved).toBe('sonnet')
  } finally {
    await launched.app.close()
  }
})
