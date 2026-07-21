import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Browser pane tabs (Angel's Jul-15 report: ⌘W in the browser closed the whole
 * app — the fileMenu role owned the accelerator — and there was only one tab).
 * These cover the tab MECHANICS (add/switch/close/⌘W scoping) without loading
 * real pages; the menu-accelerator fix is main-process (not reachable here).
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function openBrowserTab(page: LaunchedApp['page']): Promise<void> {
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'browser-tabs',
        firstPrompt: 'hello'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'browser-tabs' }).click()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
  await page.locator('.tile-tabs button', { hasText: 'Browser' }).click()
}

/** simulate a ⌘-clicked link (chat/terminal/guest page) routed to the pane */
async function openLinkInFocused(page: LaunchedApp['page'], url: string): Promise<void> {
  await page.evaluate((u) => {
    const store = (
      window as unknown as {
        __hang4r_store: {
          getState(): { focusedSessionId: string | null; requestOpenUrl(sid: string, url: string): void }
        }
      }
    ).__hang4r_store.getState()
    store.requestOpenUrl(store.focusedSessionId!, u)
  }, url)
}

test('browser opens with one tab; + adds; × closes; switching keeps per-tab URLs', async () => {
  launched = await launchApp()
  const { page } = launched
  await openBrowserTab(page)

  const tabs = page.locator('.browser-tab')
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toContainText('New Tab')

  // + adds a tab and focuses it
  await page.locator('.browser-tab-add').click()
  await expect(tabs).toHaveCount(2)
  await expect(page.locator('.browser-tab-active')).toContainText('New Tab')

  // each tab keeps its own URL-bar draft
  await page.locator('.browser-url').fill('localhost:5173')
  await tabs.first().click()
  await expect(page.locator('.browser-url')).toHaveValue('')
  await tabs.nth(1).click()
  await expect(page.locator('.browser-url')).toHaveValue('localhost:5173')

  // × closes a tab (never the pane)
  await page.locator('.browser-tab').nth(1).locator('.browser-tab-close').click()
  await expect(tabs).toHaveCount(1)
  await expect(page.locator('.browser-pane')).toBeVisible()
})

test('⌘W closes the active browser tab, not the tile; lone empty tab falls through', async () => {
  launched = await launchApp()
  const { page } = launched
  await openBrowserTab(page)

  await page.locator('.browser-tab-add').click()
  await page.locator('.browser-tab-add').click()
  await expect(page.locator('.browser-tab')).toHaveCount(3)

  await page.keyboard.press('Meta+KeyW')
  await expect(page.locator('.browser-tab')).toHaveCount(2)
  await page.keyboard.press('Meta+KeyW')
  await expect(page.locator('.browser-tab')).toHaveCount(1)
  // the tile survived every tab close
  await expect(page.locator('.pane')).toHaveCount(1)
})

test('browser tabs survive a tile remount (state lives in the store)', async () => {
  launched = await launchApp()
  const { page } = launched
  await openBrowserTab(page)

  await page.locator('.browser-tab-add').click()
  await page.locator('.browser-url').fill('localhost:3000')
  await expect(page.locator('.browser-tab')).toHaveCount(2)

  // leave the session and come back — the pane remounts from the store
  await page.locator('.tile .tile-tabs button', { hasText: 'Files' }).click()
  await page.locator('.tile-tabs button', { hasText: 'Browser' }).click()
  await expect(page.locator('.browser-tab')).toHaveCount(2)
  await expect(page.locator('.browser-url')).toHaveValue('localhost:3000')
})

test('a clicked link opens a NEW tab; only a pristine tab is reused (Angel lost work to a link clobbering his active tab)', async () => {
  launched = await launchApp()
  const { page } = launched
  await openBrowserTab(page)

  // give the lone tab content (the URL never resolves — content-state is what matters)
  await page.locator('.browser-url').fill('localhost:5990')
  await page.locator('.browser-url').press('Enter')
  await expect(page.locator('.browser-tab')).toHaveCount(1)

  const openLink = (url: string): Promise<void> =>
    page.evaluate((u) => {
      const store = (
        window as unknown as {
          __hang4r_store: {
            getState(): {
              focusedSessionId: string | null
              requestOpenUrl(sid: string, url: string): void
            }
          }
        }
      ).__hang4r_store.getState()
      store.requestOpenUrl(store.focusedSessionId!, u)
    }, url)

  // link click → lands in a fresh tab, active tab's content untouched
  await openLink('http://localhost:5991')
  await expect(page.locator('.browser-tab')).toHaveCount(2)
  await expect(page.locator('.browser-tab-active')).toContainText('localhost:5991')
  await expect(page.locator('.browser-tab').first()).toContainText('localhost:5990')

  // a pristine tab (fresh +) IS reused instead of stacking another
  await page.locator('.browser-tab-add').click()
  await expect(page.locator('.browser-tab')).toHaveCount(3)
  await openLink('http://localhost:5992')
  await expect(page.locator('.browser-tab')).toHaveCount(3)
  await expect(page.locator('.browser-tab-active')).toContainText('localhost:5992')
})

test('the browser <webview> survives a context-panel switch — kept MOUNTED, never reloaded (Angel: the page kept getting wiped)', async () => {
  launched = await launchApp()
  const { page } = launched
  await openBrowserTab(page)

  // navigate so an actual <webview> element exists for the tab
  await page.locator('.browser-url').fill('localhost:5990')
  await page.locator('.browser-url').press('Enter')
  await expect(page.locator('.browser-webview')).toHaveCount(1)

  const tile = page.locator('.tile').first()
  // switch to another context panel — before the fix this UNMOUNTED the pane
  // and the webview reloaded its src, wiping the page. Now it stays in the DOM.
  await tile.locator('.tile-tabs button', { hasText: 'Files' }).click()
  await expect(page.locator('.files-tree, .files-code, .file-row').first()).toBeVisible({ timeout: 5_000 })
  // the SAME webview element is still mounted (hidden), not destroyed
  await expect(page.locator('.browser-webview')).toHaveCount(1)

  // back to Browser: the webview is shown again, same tab/url
  await tile.locator('.tile-tabs button', { hasText: 'Browser' }).click()
  await expect(page.locator('.browser-webview')).toBeVisible()
  await expect(page.locator('.browser-tab')).toHaveCount(1)
})

test('a link-opened tab is NOT duplicated when you leave the Browser panel and return (Angel: tabs kept multiplying)', async () => {
  launched = await launchApp()
  const { page } = launched
  await openBrowserTab(page)

  // give the lone tab content so the link opens a SECOND tab (pristine reuse
  // would otherwise keep it at one)
  await page.locator('.browser-url').fill('localhost:5990')
  await page.locator('.browser-url').press('Enter')
  await openLinkInFocused(page, 'http://localhost:5991')
  await expect(page.locator('.browser-tab')).toHaveCount(2)

  // switch away and back MULTIPLE times — the urlToOpen trigger must be
  // consumed so a pane remount never replays it into another duplicate tab
  for (let i = 0; i < 3; i++) {
    await page.locator('.tile .tile-tabs button', { hasText: 'Files' }).click()
    await page.locator('.tile-tabs button', { hasText: 'Browser' }).click()
    await expect(page.locator('.browser-tab')).toHaveCount(2)
  }
})

test('⌘T in the browser chrome opens a new tab (standard browser keybindings)', async () => {
  launched = await launchApp()
  const { page } = launched
  await openBrowserTab(page)

  await page.locator('.browser-url').click()
  await page.keyboard.press('Meta+KeyT')
  await expect(page.locator('.browser-tab')).toHaveCount(2)
  await expect(page.locator('.browser-tab-active')).toContainText('New Tab')
})

test('link click with ONLY the conversation open: pane opens AND loads on the FIRST click (Angel needed two)', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'first-click',
        firstPrompt: 'hello'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'first-click' }).click()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
  // Browser context NOT opened — the link click must both open it and load

  await page.evaluate((u) => {
    const store = (
      window as unknown as {
        __hang4r_store: {
          getState(): {
            focusedSessionId: string | null
            requestOpenUrl(sid: string, url: string): void
          }
        }
      }
    ).__hang4r_store.getState()
    store.requestOpenUrl(store.focusedSessionId!, u)
  }, 'http://localhost:5993')

  await expect(page.locator('.browser-pane')).toBeVisible()
  await expect(page.locator('.browser-url')).toHaveValue('http://localhost:5993')
  await expect(page.locator('.browser-tab')).toHaveCount(1)
  await expect(page.locator('.browser-tab-active')).toContainText('localhost:5993')
})

test('⌘F with the browser chrome focused opens a "Find in page" bar (the shared find component)', async () => {
  launched = await launchApp()
  const { page } = launched
  await openBrowserTab(page)

  // focus the browser chrome so ⌘F routes to THIS pane (App.tsx dispatches by
  // focused panel) — it uses the SAME find chrome as chat/editor/terminal.
  await page.locator('.browser-url').click()
  const bar = page.locator('.browser-pane .chat-find-bar')
  await expect(bar).toHaveCount(0)
  await page.keyboard.press('Meta+f')
  await expect(bar).toBeVisible()
  await expect(bar.locator('.chat-find-input')).toHaveAttribute('placeholder', 'Find in page')

  await page.keyboard.press('Escape')
  await expect(page.locator('.browser-pane .chat-find-bar')).toHaveCount(0)
})
