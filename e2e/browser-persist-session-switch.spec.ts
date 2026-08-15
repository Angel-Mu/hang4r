import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The bug (Angel): switch to another session and back, and a session's open
 * Browser tab RELOADED — lost scroll, form state, history — because hang4r is
 * single-open (switching UNMOUNTS the previous tile, which destroyed its
 * <webview>). The fix moves the webview into an app-level BrowserLayer that
 * outlives the tile; the tile only reports where to overlay it.
 *
 * Proof: tag the live <webview> DOM node with a unique attribute, switch away to
 * another session and back, and assert the SAME node is still there (marker
 * intact). A reload/remount would have created a fresh node without the marker.
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a browser tab survives switching to another session and back — no reload', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)

  // two sessions in the same project: A has the browser, B is where we go away to
  for (const title of ['persist-a', 'persist-b']) {
    await page.evaluate(
      ({ pid, t }) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title: t,
          firstPrompt: 'hi'
        }),
      { pid: project.id, t: title }
    )
  }
  await page.reload()
  await page.waitForSelector('.app')

  // open A, open its Browser panel, and load a URL so a real <webview> exists
  await page.locator('.session-row', { hasText: 'persist-a' }).click()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
  await page.locator('.tile-tabs button', { hasText: 'Browser' }).click()
  await page.locator('.browser-url').fill('localhost:5990')
  await page.locator('.browser-url').press('Enter')
  await expect(page.locator('.browser-webview')).toHaveCount(1)
  await expect(page.locator('.browser-webview')).toBeVisible()

  // tag the live webview node — this marker only survives if the node is never
  // destroyed (i.e. the pane was NOT unmounted + remounted)
  await page.locator('.browser-webview').evaluate((el) => {
    el.setAttribute('data-persist-marker', 'keepme')
  })

  // go away to session B (single-open → A's tile unmounts)
  await page.locator('.session-row', { hasText: 'persist-b' }).click()
  await page.locator('.tile-title', { hasText: 'persist-b' }).first().waitFor({ timeout: 20_000 })
  // A's webview stays MOUNTED in the layer (hidden) — same node, marker intact
  await expect(page.locator('.browser-webview[data-persist-marker="keepme"]')).toHaveCount(1)

  // come back to A
  await page.locator('.session-row', { hasText: 'persist-a' }).click()
  await page.locator('.tile-title', { hasText: 'persist-a' }).first().waitFor({ timeout: 20_000 })

  // the SAME webview node is still there (marker survived → never reloaded),
  // still the only one, its address bar state preserved, and visible again
  await expect(page.locator('.browser-webview')).toHaveCount(1)
  await expect(page.locator('.browser-webview')).toHaveAttribute('data-persist-marker', 'keepme')
  await expect(page.locator('.browser-webview')).toBeVisible()
  await expect(page.locator('.browser-tab')).toHaveCount(1)
  // address-bar state preserved (go() normalized the omnibox entry to a full URL)
  await expect(page.locator('.browser-url')).toHaveValue('http://localhost:5990')
})
