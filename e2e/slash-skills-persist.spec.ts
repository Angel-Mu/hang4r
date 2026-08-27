import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "`/` is not showing all the skills nor commands sometimes… it works
 * for internal commands, but my skills are not shown".
 *
 * The built-ins are hardcoded, so they always render. Skills and slash commands
 * come from the session's `init` event, which main persists like any other —
 * but the renderer only ever read it from the LIVE stream. Reopening a session,
 * or restarting the app, therefore left the menu with the built-ins alone until
 * the next turn re-announced them.
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('a reopened session still offers its skills in the / menu', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('a turn, so the CLI announces itself')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  // reload: the live init event is gone, only the persisted one remains
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row').first().click()
  await page.locator('.tile .status-dot').first().waitFor({ timeout: 20_000 })

  const composer = page.locator('.composer-input')
  await composer.click()
  await composer.fill('/')
  const menu = page.locator('.slash-menu')
  await expect(menu).toBeVisible({ timeout: 10_000 })
  // the built-ins were never the problem
  await expect(menu).toContainText('rename')
  // …these are: they come from the session's own init
  await expect(menu.locator('.slash-cat', { hasText: 'Skills' })).toBeVisible()
  await expect(menu).toContainText('artifact-design')
})

test('typing part of a skill name still finds it after a reload', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill('a turn')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row').first().click()
  await page.locator('.tile .status-dot').first().waitFor({ timeout: 20_000 })

  const composer = page.locator('.composer-input')
  await composer.click()
  // Angel typed "/super" and got nothing at all — no menu, not even a miss
  await composer.fill('/brain')
  await expect(page.locator('.slash-menu')).toContainText('brainstorming', { timeout: 10_000 })
})

// Angel: "I hit send, then appeared :o … but now is useless there". The menus
// tracked their own open state while keying off a draft that Send had emptied,
// so one could surface after the message was already gone.
test('sending closes the typeahead instead of leaving it pointing at nothing', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  const composer = page.locator('.composer-input')
  await composer.click()
  await composer.fill('ship it /ren')
  await expect(page.locator('.slash-menu')).toBeVisible()

  // Enter with the menu open PICKS an item, by design — so send the way Angel
  // did, with the button, while the menu state is still set
  await page.locator('.tile .composer-send').click()
  await expect(composer).toHaveValue('')
  await expect(page.locator('.slash-menu')).toHaveCount(0)
  // and it must not resurface once the turn re-announces the session's skills
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.slash-menu')).toHaveCount(0)
})
