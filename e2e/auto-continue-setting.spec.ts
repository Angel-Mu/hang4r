import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp } from './helpers'

/**
 * The auto-continue toggle (Angel wanted control over the automatic "continue"
 * that recovers a poisoned interactive-CLI conversation). This guards the SETTING
 * wiring: it's registered with the bool codec, defaults ON (unset ≠ 'off'), and
 * round-trips. sessionManager.maybeAutoContinue reads it via getSetting === 'off'.
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('autoContinue setting defaults ON and round-trips through the bool codec', async () => {
  launched = await launchApp()
  const { page } = launched

  // unset → the reader treats it as ON (getSetting is null or 'on', never 'off')
  const initial = await page.evaluate(() => window.hang4r.getSetting('autoContinue'))
  expect(initial === null || initial === 'on').toBeTruthy()

  await page.evaluate(() => window.hang4r.setSetting('autoContinue', 'off'))
  expect(await page.evaluate(() => window.hang4r.getSetting('autoContinue'))).toBe('off')

  await page.evaluate(() => window.hang4r.setSetting('autoContinue', 'on'))
  expect(await page.evaluate(() => window.hang4r.getSetting('autoContinue'))).toBe('on')
})
