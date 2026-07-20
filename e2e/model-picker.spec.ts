import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel's Jul-16 report: cursor-agent lists ~190 model variants, the picker
 * menu didn't scroll (Composer unreachable), and Claude's reasoning-effort
 * chips rendered on Cursor sessions where no real effort flag exists.
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function openSession(
  page: LaunchedApp['page'],
  backend: 'claude' | 'cursor',
  title: string
): Promise<void> {
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid, backend, title }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend,
        environment: 'local',
        permissionMode: 'default',
        title,
        firstPrompt: 'hello'
      }),
    { pid: project.id, backend, title }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: title }).click()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
}

test('model menu scrolls, and effort chips are hidden on cursor (no real flag there)', async () => {
  launched = await launchApp()
  const { page } = launched
  await openSession(page, 'cursor', 'cursor-picker')
  const tile = page.locator('.tile').first()

  await tile.locator('.model-picker-trigger').click()
  const menu = tile.locator('.model-menu')
  await expect(menu).toBeVisible()

  // the list is the scroll container and the menu is height-capped — with
  // cursor-agent's ~190 variants the old menu overflowed the pane unscrollably
  const listStyle = await menu.locator('.model-menu-list').evaluate((el) => {
    const cs = getComputedStyle(el)
    return { overflowY: cs.overflowY }
  })
  expect(listStyle.overflowY).toBe('auto')
  const menuBox = await menu.boundingBox()
  const viewport = page.viewportSize()
  expect(menuBox!.height).toBeLessThanOrEqual((viewport?.height ?? 900) * 0.75)

  // cursor has NO real effort flag (effort lives in the model slug) — the
  // Claude/Codex chips must not render as a dead control here
  await expect(menu.locator('.model-menu-efforts')).toHaveCount(0)

  // with a big real catalog (cursor-agent installed) the search box appears
  // and filters; on machines without cursor-agent the fallback list is short
  const count = await menu.locator('.model-menu-item').count()
  if (count > 8) {
    const search = menu.locator('.model-menu-search')
    await expect(search).toBeVisible()
    await search.fill('composer')
    const filtered = menu.locator('.model-menu-item')
    await expect(filtered.first()).toContainText(/composer/i)
  }
})

test('effort chips still render for claude (real --effort flag)', async () => {
  launched = await launchApp()
  const { page } = launched
  await openSession(page, 'claude', 'claude-picker')
  const tile = page.locator('.tile').first()

  await tile.locator('.model-picker-trigger').click()
  const menu = tile.locator('.model-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.model-menu-efforts')).toBeVisible()
})
