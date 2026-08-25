import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: `:see_no_evil:` showed up literally in the conversation, and typing a
 * shortcode offered nothing — he wanted the WhatsApp behaviour, a strip of
 * matches you pick from while writing.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function openComposer(page: LaunchedApp['page']): Promise<void> {
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.dialog')).toBeHidden()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
}

test('typing a :shortcode offers matches, and picking one inserts the emoji itself', async () => {
  launched = await launchApp()
  const { page } = launched
  await openComposer(page)

  const composer = page.locator('.composer-input')
  await composer.click()
  await composer.fill(':see')

  const menu = page.locator('.emoji-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.emoji-item').first()).toHaveText('🙈')
  await expect(menu.locator('.emoji-menu-hint')).toHaveText(':see_no_evil:')

  // Enter takes the highlighted one and leaves the glyph, not the shortcode
  await composer.press('Enter')
  await expect(menu).toBeHidden()
  await expect(composer).toHaveValue('🙈')
})

test('arrow keys walk the strip', async () => {
  launched = await launchApp()
  const { page } = launched
  await openComposer(page)

  const composer = page.locator('.composer-input')
  await composer.click()
  await composer.fill(':see')
  await expect(page.locator('.emoji-menu')).toBeVisible()
  await composer.press('ArrowRight')
  await expect(page.locator('.emoji-menu-hint')).toHaveText(':seedling:')
  await composer.press('Enter')
  await expect(composer).toHaveValue('🌱')
})

test('Escape dismisses the strip and leaves the text alone', async () => {
  launched = await launchApp()
  const { page } = launched
  await openComposer(page)

  const composer = page.locator('.composer-input')
  await composer.click()
  await composer.fill(':tada')
  await expect(page.locator('.emoji-menu')).toBeVisible()
  await composer.press('Escape')
  await expect(page.locator('.emoji-menu')).toBeHidden()
  await expect(composer).toHaveValue(':tada')
})

test('a sent :shortcode: renders as the emoji in the conversation', async () => {
  launched = await launchApp()
  const { page } = launched
  await openComposer(page)

  const composer = page.locator('.composer-input')
  await composer.click()
  // typed in full and sent without touching the menu — the old literal case
  await composer.fill('ship it :tada:')
  await composer.press('Escape')
  await composer.press('Enter')

  await expect(page.locator('.tile .msg-user-card').first()).toContainText('ship it 🎉', {
    timeout: 15_000
  })
})

test('a :shortcode: inside a code fence stays literal — it is being talked about', async () => {
  launched = await launchApp()
  const { page } = launched
  await openComposer(page)

  const composer = page.locator('.composer-input')
  await composer.click()
  await composer.fill('look:\n```\nprint(":tada:")\n```')
  await composer.press('Escape')
  await composer.press('Enter')

  const card = page.locator('.tile .msg-user-card').first()
  await expect(card.locator('pre')).toContainText(':tada:', { timeout: 15_000 })
  await expect(card.locator('pre')).not.toContainText('🎉')
})
