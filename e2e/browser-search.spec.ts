import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Address bar = omnibox (Angel: couldn't search from it). A bare host navigates;
 * a query becomes a web search instead of being rejected / loading http://<junk>.
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function openBrowser(page: LaunchedApp['page']): Promise<string> {
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'omnibox',
        firstPrompt: 'hi'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'omnibox' }).click()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
  await page.locator('.tile-tabs button', { hasText: 'Browser' }).click()
  return page.evaluate(
    () =>
      (window as unknown as { __hang4r_store: { getState(): { focusedSessionId: string } } })
        .__hang4r_store.getState().focusedSessionId
  )
}

const activeUrl = (page: LaunchedApp['page'], sid: string): Promise<string> =>
  page.evaluate((s) => {
    const st = (
      window as unknown as {
        __hang4r_store: {
          getState(): { browserTabs: Record<string, { tabs: { id: string; url: string }[]; activeId: string }> }
        }
      }
    ).__hang4r_store.getState().browserTabs[s]
    return st.tabs.find((t) => t.id === st.activeId)?.url ?? ''
  }, sid)

test('a multi-word query in the address bar becomes a web search', async () => {
  launched = await launchApp()
  const { page } = launched
  const sid = await openBrowser(page)

  await page.locator('.browser-url').fill('ui ux pro max')
  await page.locator('.browser-url').press('Enter')

  await expect(async () => {
    const url = await activeUrl(page, sid)
    expect(url).toContain('google.com/search')
    expect(url).toContain('ui%20ux%20pro%20max')
  }).toPass({ timeout: 5_000 })
})

test('a bare host still navigates directly, not searched', async () => {
  launched = await launchApp()
  const { page } = launched
  const sid = await openBrowser(page)

  await page.locator('.browser-url').fill('example.com')
  await page.locator('.browser-url').press('Enter')

  await expect(async () => {
    const url = await activeUrl(page, sid)
    expect(url).toBe('http://example.com')
  }).toPass({ timeout: 5_000 })
})
