import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "this kind of modals do not dismiss on esc key press."
 *
 * Only the prompt dialog handled Escape, and only while its input had focus. The
 * save and confirm dialogs have no input, so neither could be dismissed by
 * keyboard at all.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function app(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
}

test('Escape cancels the unsaved-changes prompt', async () => {
  launched = await launchApp()
  const { page } = launched
  await app(page)

  const result = page.evaluate(() =>
    (
      window as unknown as {
        __hang4r_store: {
          getState(): { showSave(t: string, d: string): Promise<string> }
        }
      }
    ).__hang4r_store.getState().showSave('Save changes to .env?', 'Changes will be lost.')
  )
  await expect(page.locator('.dialog-backdrop')).toBeVisible({ timeout: 10_000 })

  await page.keyboard.press('Escape')
  // cancel, not "don't save": Escape must never be the destructive answer
  expect(await result).toBe('cancel')
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0)
})

test('Escape cancels a confirm dialog', async () => {
  launched = await launchApp()
  const { page } = launched
  await app(page)

  const result = page.evaluate(() =>
    (
      window as unknown as {
        __hang4r_store: { getState(): { showConfirm(t: string): Promise<boolean> } }
      }
    ).__hang4r_store.getState().showConfirm('Delete this session?')
  )
  await expect(page.locator('.dialog-backdrop')).toBeVisible({ timeout: 10_000 })

  await page.keyboard.press('Escape')
  expect(await result).toBe(false)
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0)
})

test('Escape still cancels the prompt dialog', async () => {
  launched = await launchApp()
  const { page } = launched
  await app(page)

  const result = page.evaluate(() =>
    (
      window as unknown as {
        __hang4r_store: { getState(): { showPrompt(t: string, i?: string): Promise<string | null> } }
      }
    ).__hang4r_store.getState().showPrompt('Rename to:', 'old-name')
  )
  await expect(page.locator('.dialog-backdrop')).toBeVisible({ timeout: 10_000 })

  await page.keyboard.press('Escape')
  expect(await result).toBeNull()
})
