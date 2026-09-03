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

// Angel: "font sizes are super inconsistent on here" — the Settings panel alone
// used 11, 11.5, 12, 12.5, 13 and 18px. Half-steps are the tell that a size was
// picked per-element rather than from a scale.
test('the interface uses one type ladder, with no ad-hoc half-pixel sizes', async () => {
  launched = await launchApp()
  const { page } = launched
  await page.waitForSelector('.app')

  const offenders = await page.evaluate(() => {
    const bad: string[] = []
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue
        const fs = rule.style.getPropertyValue('font-size')
        // a bare px size that is not on the ladder, ignoring the one display size
        if (/^\d+\.5px$/.test(fs.trim())) bad.push(`${rule.selectorText} → ${fs}`)
      }
    }
    return bad
  })

  expect(offenders).toEqual([])
})

// Angel: at a larger setting "everything looks ugly there… should be a little
// smaller as before, but would be able to change accordingly". The ladder used
// fixed px offsets, so the hierarchy flattened as the size grew: 11/12/13 reads
// clearly, 16/17/18 does not. It is proportional now, and this checks the RATIO
// holds at both ends rather than checking a count of sizes.
test('the type hierarchy holds at small and large interface sizes', async () => {
  launched = await launchApp()
  const { page } = launched
  await page.waitForSelector('.app')

  const measure = async (base: number): Promise<{ label: number; hint: number }> => {
    await page.evaluate((px) => {
      const st = (
        window as unknown as { __hang4r_store: { getState(): { setChatFontSize(n: number): void } } }
      ).__hang4r_store.getState()
      st.setChatFontSize(px)
    }, base)
    await page.keyboard.press('Meta+Comma')
    await expect(page.locator('.settings-body')).toBeVisible({ timeout: 10_000 })
    const out = await page.evaluate(() => {
      const px = (sel: string): number => {
        const el = document.querySelector(sel)
        return el ? parseFloat(getComputedStyle(el).fontSize) : -1
      }
      return { label: px('.notify-toggle'), hint: px('.notify-hint') }
    })
    await page.keyboard.press('Escape')
    return out
  }

  const small = await measure(12)
  const large = await measure(20)

  expect(small.label).toBeGreaterThan(0)
  expect(large.label).toBeGreaterThan(small.label)
  // supporting copy stays visibly smaller at BOTH ends — the fixed-offset ladder
  // held this at 12px and lost it by 20px
  for (const m of [small, large]) {
    expect(m.hint / m.label).toBeLessThan(0.9)
    expect(m.hint / m.label).toBeGreaterThan(0.75)
  }
})

// Angel kept finding new size mismatches in Settings. The panel reads at three
// sizes on purpose — uppercase section label, supporting hint, body — and a
// fourth is what made it look arbitrary.
test('the settings panel reads at no more than three sizes', async () => {
  launched = await launchApp()
  const { page } = launched
  await page.waitForSelector('.app')
  await page.keyboard.press('Meta+Comma')
  await expect(page.locator('.settings-body')).toBeVisible({ timeout: 10_000 })

  const sizes = await page.evaluate(() => {
    const seen = new Map<string, number>()
    const root = document.querySelector('.settings-body')
    if (!root) return []
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const text = (el.textContent ?? '').trim()
      if (!text || el.children.length > 0) continue // leaf text only
      const fs = getComputedStyle(el).fontSize
      seen.set(fs, (seen.get(fs) ?? 0) + 1)
    }
    // sizes used by more than a stray element
    return [...seen.entries()].filter(([, n]) => n > 1).map(([fs]) => fs)
  })

  expect(sizes.length).toBeLessThanOrEqual(3)
})
