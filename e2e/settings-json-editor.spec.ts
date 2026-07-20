import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The settings.json editing surface (round 14 ④⑥): the category widens the
 * modal and the Monaco host flex-fills the leftover height (no more cramped
 * strip), and an empty workspace scope opens with a fully-commented,
 * schema-generated template instead of a bare `{}`.
 */
test.describe('settings.json editor', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  async function openSettingsJson(page: LaunchedApp['page']): Promise<void> {
    await page.keyboard.press('Meta+k')
    await page.locator('.palette-input').fill('settings')
    await page.locator('.palette-input').press('Enter')
    await expect(page.locator('.settings-page')).toBeVisible()
    await page.locator('.settings-nav-item', { hasText: 'settings.json' }).click()
  }

  test('the category widens the modal and the editor host fills the height', async () => {
    launched = await launchApp()
    const { page } = launched
    await page.waitForSelector('.app')
    await openSettingsJson(page)

    // widened modal is the mechanism that gives the editor room
    await expect(page.locator('.settings-page.settings-page--wide')).toBeVisible()

    // the Monaco host flex-fills — far taller than the old fixed 320px strip
    const host = page.locator('.settings-json-host')
    await expect(host).toBeVisible()
    const h = await host.evaluate((el) => (el as HTMLElement).clientHeight)
    expect(h).toBeGreaterThan(360)
  })

  test('an empty workspace scope opens with the commented, schema-generated template', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await openSettingsJson(page)

    // switch File scope from the app file to the (empty) workspace file
    await page.locator('.settings-content select.field').selectOption({ index: 1 })

    const host = page.locator('.settings-json-host')
    await expect(host).toBeVisible()
    // a known workspace key is present AS A COMMENT with its description text
    await expect(host).toContainText('// worktreeDir')
    await expect(host).toContainText('Worktree container folder for this repo')
    // the file doesn't exist yet, so the action offers to CREATE it
    await expect(
      page.locator('.settings-json-actions .primary-btn', { hasText: 'Create file' })
    ).toBeVisible()

    // creating it writes the template (comments included) to disk, then the
    // button flips to the normal Save label
    await page.locator('.settings-json-actions .primary-btn', { hasText: 'Create file' }).click()
    await expect(page.locator('.settings-json-editor .settings-saved')).toBeVisible()
    await expect(
      page.locator('.settings-json-actions .primary-btn', { hasText: 'Save file' })
    ).toBeVisible()
  })
})
