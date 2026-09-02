import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel asked whether session-to-session agent messaging is possible. It already
 * is — the CLI gives every session SendMessage and ListAgents, and hang4r's
 * sessions register with it. What was missing is the NAME a session answers to.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a session offers the name other agents address it by', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await page.locator('.session-row').first().click({ button: 'right' })
  const item = page.locator('.ctx-menu button', { hasText: 'Copy agent name' })
  await expect(item).toBeVisible()
  await item.click()

  // the fake agent is not a real CLI session, so it has no name — the panel must
  // say so rather than silently copying nothing
  await expect(page.locator('.lightbox-backdrop')).toContainText(/agent name/i, {
    timeout: 10_000
  })
})
