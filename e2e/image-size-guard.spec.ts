import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "API Error: an image in the conversation could not be processed and was
 * removed" on every turn, however small the NEW image was.
 *
 * The API validates the whole conversation, so one oversized image poisons every
 * later request in that session. hang4r sent whatever was pasted, unbounded —
 * his store held one image event of 35MB and four more over 4MB, against an API
 * ceiling of roughly 5MB per image.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a huge pasted screenshot is shrunk before it is ever sent', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // a 6000x4000 PNG of noise — far past the API's per-image ceiling, and past
  // the 1568px edge beyond which the model re-scales anyway
  const pasted = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 6000
    c.height = 4000
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(c.width, 1)
    for (let y = 0; y < c.height; y += 1) {
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = (i + y) % 255
        img.data[i + 1] = (i * 7 + y) % 255
        img.data[i + 2] = (i * 13 + y) % 255
        img.data[i + 3] = 255
      }
      ctx.putImageData(img, 0, y)
    }
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
    const file = new File([blob], 'huge.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const composer = document.querySelector('.composer-input') as HTMLTextAreaElement
    composer.focus()
    composer.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    )
    return blob.size
  })
  expect(pasted).toBeGreaterThan(0)

  // the attachment card appears, and what it holds is within the model's limits
  await expect(page.locator('.tile .context-chip, .tile .attach-item').first()).toBeVisible({
    timeout: 15_000
  })
  const sent = await page.evaluate(async () => {
    const st = (
      window as unknown as {
        __hang4r_store: {
          getState(): { attachments: Record<string, { image?: { base64: string; mediaType: string } }[]> }
        }
      }
    ).__hang4r_store.getState()
    const img = Object.values(st.attachments).flat().find((a) => a.image)?.image
    if (!img) return null
    // decode what would actually be sent, to check the long edge came down.
    // atob rather than fetch(data:…) — the app's CSP blocks that.
    const bin = atob(img.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const bitmap = await createImageBitmap(new Blob([bytes], { type: img.mediaType }))
    return { bytes: img.base64.length, width: bitmap.width, height: bitmap.height }
  })
  expect(sent).not.toBeNull()
  // 6000px wide went in; the model re-scales past 1568 anyway, so it must not
  // be uploaded at full size
  expect(sent!.width).toBeLessThanOrEqual(1568)
  expect(sent!.height).toBeLessThanOrEqual(1568)
  expect(sent!.bytes).toBeLessThan(5_000_000)
})
