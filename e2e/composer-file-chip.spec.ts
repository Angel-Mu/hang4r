import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "when you add a file, like a json to the composer, it looks like plain
 * text, rather than look like an attached file… we do have attached the file but
 * UI does not looks like it."
 *
 * The attachment was real; the chip just rendered a glyph and a filename, which
 * reads as typed text. The sent message already showed a proper card with a type
 * badge — the composer now shows the same thing before sending.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('an attached file shows as a file card with its type, not as text', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // drop a .json on the composer, the way Angel adds one
  await page.evaluate(() => {
    const file = new File(['{"a":1}'], 'config.json', { type: 'application/json' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const composer = document.querySelector('.composer') as HTMLElement
    composer.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })

  const chip = page.locator('.tile .context-chip').first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await expect(chip).toHaveClass(/context-chip-file/)
  // the type badge is what makes it read as a file rather than typed text
  await expect(chip.locator('.chip-badge')).toHaveText('JSON')
  await expect(chip).toContainText('config.json')

  // and the composer text is untouched — the file is an attachment, not content
  await expect(page.locator('.tile .composer-input')).toHaveValue('')
})

test('an image attachment still shows its thumbnail, not a badge', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 40
    c.height = 40
    c.getContext('2d')!.fillRect(0, 0, 40, 40)
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
    const composer = document.querySelector('.composer') as HTMLElement
    composer.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })

  const chip = page.locator('.tile .context-chip').first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await expect(chip.locator('.chip-thumb')).toBeVisible()
  await expect(chip.locator('.chip-badge')).toHaveCount(0)
})
