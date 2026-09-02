import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "I can see the update on the font size for the new agent modal but only
 * affected the static text, the text that we write is too small".
 *
 * Labels inherit from body; input, textarea and select do not — browsers give
 * them their own defaults, so raising the setting scaled the chrome and left
 * every typed value behind.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('what you type scales with the interface font, not just the labels', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  await page.evaluate(() => {
    const st = (window as unknown as { __hang4r_store: { getState(): { setChatFontSize(px: number): void } } })
      .__hang4r_store.getState()
    st.setChatFontSize(19)
  })

  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await expect(page.locator('.dialog')).toBeVisible()

  const sizes = await page.evaluate(() => {
    const px = (sel: string): number => {
      const el = document.querySelector(sel)
      return el ? parseFloat(getComputedStyle(el).fontSize) : -1
    }
    const el = document.querySelector('.dialog .dialog-prompt') as HTMLElement | null
    const chain: string[] = []
    for (let n = el; n && chain.length < 6; n = n.parentElement) {
      chain.push(`${n.tagName}.${n.className}=${getComputedStyle(n).fontSize}`)
    }
    console.log('VAR=' + getComputedStyle(document.documentElement).getPropertyValue('--chat-font'))
    console.log('CHAIN=' + chain.join(' | '))
    return {
      label: px('.dialog .field-label'),
      prompt: px('.dialog .dialog-prompt'),
      select: px('.dialog select'),
      text: px('.dialog input[type="text"]')
    }
  })

  expect(sizes.label).toBeGreaterThan(0)
  // the typed surfaces track the same scale the labels do
  expect(sizes.prompt).toBe(19)
  expect(sizes.select).toBe(19)
  if (sizes.text > 0) expect(sizes.text).toBe(19)
})
