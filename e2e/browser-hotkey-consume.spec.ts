import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A browser keybinding intercepted from the guest page (⌘T/⌘L/⌘W/…) is a
 * one-shot signal — BrowserPane must CONSUME it after acting, or a pane remount
 * (jumping between conversations) replays it. Angel hit exactly this: a stale
 * ⌘T (new-tab) re-fired on every session switch, spawning a fresh "New Tab"
 * each time. Mirrors the urlToOpen consume.
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a browser hotkey is consumed after acting (no phantom New Tab on remount)', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'hotkey',
        firstPrompt: 'hi'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'hotkey' }).click()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
  await page.locator('.tile-tabs button', { hasText: 'Browser' }).click()
  const sid = await page.evaluate(
    () =>
      (window as unknown as { __hang4r_store: { getState(): { focusedSessionId: string } } })
        .__hang4r_store.getState().focusedSessionId
  )

  await expect(page.locator('.browser-tab')).toHaveCount(1)

  // simulate a ⌘T the guest page swallowed → main → onBrowserHotkey → store
  await page.evaluate((s) => {
    ;(
      window as unknown as { __hang4r_store: { setState(p: unknown): void } }
    ).__hang4r_store.setState({
      browserHotkey: { sessionId: s, tabId: '', action: 'new-tab', nonce: 7 }
    })
  }, sid)

  // it added exactly ONE tab...
  await expect(page.locator('.browser-tab')).toHaveCount(2)
  // ...and the hotkey signal is now CONSUMED (null) — so a later remount that
  // re-runs this effect on mount finds nothing to replay
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __hang4r_store: { getState(): { browserHotkey: unknown } } })
            .__hang4r_store.getState().browserHotkey
      )
    )
    .toBeNull()
})
