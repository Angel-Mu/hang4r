import { test, expect } from '@playwright/test'
import { untranslateUrl } from '../src/renderer/src/components/BrowserPane'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "Fix file links, opening on browser rather than IDE" — his screenshot
 * showed an absolute path into a SIBLING worktree, i.e. outside this session's
 * own directory. openFileHref only handled paths under the session cwd and
 * returned false for the rest, so the caller fell through to the browser and
 * showed a raw file:// page.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a file link outside the session does not escape to the browser', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('link an outside file')
  await page.getByRole('button', { name: /Start agent/ }).click()

  const link = page.locator('.tile .msg-assistant a', { hasText: 'lambda.stack.ts' }).first()
  await expect(link).toBeVisible({ timeout: 20_000 })
  await link.click()

  // the browser pane must never be handed a file:// url — that was the bug
  const urlOpened = await page.evaluate(() => {
    const st = (
      window as unknown as { __hang4r_store: { getState(): { urlToOpen: { url?: string } | null } } }
    ).__hang4r_store.getState()
    return st.urlToOpen?.url ?? null
  })
  // null = the browser pane was never asked at all, which is the fix
  expect(urlOpened === null || !/^file:\/\//.test(urlOpened)).toBe(true)
})

test('the translate unwrap still leaves ordinary urls alone', () => {
  // guards the browser change below from regressing the 1.0.131 behaviour
  expect(untranslateUrl('https://example.com/a')).toBeNull()
})
