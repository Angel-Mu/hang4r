import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "when watching a video or going full screen on the browser, the whole
 * app goes weird, we don't see anything else but the browser when we go out of
 * full screen." REPRO — HTML fullscreen inside the embedded <webview> guest
 * (requestFullscreen / a video's fullscreen button), then exit via
 * document.exitFullscreen() and via Escape. The rest of the app must come back.
 *
 * The browser pane lives at app root (BrowserLayer) — never tile.locator('.browser-*').
 */
let launched: LaunchedApp | null = null
let server: http.Server | null = null
test.afterEach(async () => {
  await Promise.race([
    launched?.app.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 10_000))
  ])
  launched = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

async function serve(): Promise<string> {
  server = http.createServer((_q, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(
      '<html><body style="background:#246"><h1>fs page</h1><video id="v" width="200" height="100"></video><script>window.__keys=[];addEventListener("keydown",e=>__keys.push(e.key))</script></body></html>'
    )
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

async function openBrowser(page: LaunchedApp['page'], url: string): Promise<void> {
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'fs-repro',
        firstPrompt: 'hello'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'fs-repro' }).click()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
  await page.locator('.tile-tabs button', { hasText: 'Browser' }).click()
  await page.locator('.browser-url').fill(url)
  await page.locator('.browser-url').press('Enter')
  await expect(page.locator('.browser-webview')).toHaveCount(1)
}

type Snap = {
  winFullScreen: boolean
  fullscreenElement: string | null
  matchesFullscreen: string[]
  htmlClass: string
  bodyClass: string
  webview: {
    rect: [number, number, number, number]
    position: string
    zIndex: string
    display: string
  }
  overlayRect: [number, number, number, number] | null
  visible: Record<string, boolean>
}

const winFs = (l: LaunchedApp): Promise<boolean> =>
  l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())

async function snap(l: LaunchedApp): Promise<Snap> {
  const winFullScreen = await winFs(l)
  const rest = await l.page.evaluate(() => {
    const r = (el: Element | null): [number, number, number, number] | null => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]
    }
    const vis = (sel: string): boolean => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) return false
      const b = el.getBoundingClientRect()
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
      return b.width > 0 && b.height > 0 && !!hit && (el === hit || el.contains(hit))
    }
    const wv = (document.querySelector('.browser-webview') ?? document.body) as HTMLElement
    const cs = getComputedStyle(wv)
    return {
      fullscreenElement: document.fullscreenElement
        ? document.fullscreenElement.tagName + '.' + document.fullscreenElement.className
        : null,
      matchesFullscreen: Array.from(document.querySelectorAll('*'))
        .filter((e) => e.matches(':fullscreen'))
        .map((e) => e.tagName + '.' + e.className),
      htmlClass: document.documentElement.className,
      bodyClass: document.body.className,
      webview: { rect: r(wv)!, position: cs.position, zIndex: cs.zIndex, display: cs.display },
      overlayRect: r(document.querySelector('.browser-overlay')),
      visible: {
        sidebar: vis('.sidebar'),
        composer: vis('.composer'),
        tileTabs: vis('.tile-tabs')
      }
    }
  })
  return { winFullScreen, ...rest } as Snap
}

const guestRaw = (l: LaunchedApp, js: string): Promise<unknown> =>
  l.app.evaluate(({ webContents }, code) => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
    return wc ? wc.executeJavaScript(code, true) : 'NO-GUEST' // userGesture = true
  }, js)
/** never hang the test on a wedged guest/renderer */
const guest = (l: LaunchedApp, js: string): Promise<unknown> =>
  Promise.race([
    guestRaw(l, js),
    new Promise<unknown>((r) => setTimeout(() => r('GUEST-EVAL-TIMEOUT'), 4_000))
  ])
const embedderFs = (l: LaunchedApp): Promise<unknown> =>
  Promise.race([
    l.page.evaluate(() => !!document.fullscreenElement),
    new Promise<unknown>((r) => setTimeout(() => r('EMBEDDER-EVAL-TIMEOUT'), 4_000))
  ])

/** enter guest fullscreen; returns the pre-fullscreen snapshot */
async function enter(l: LaunchedApp, preWindowFs: boolean): Promise<Snap> {
  await openBrowser(l.page, await serve())
  await expect.poll(() => guest(l, 'document.readyState')).toBe('complete')
  if (preWindowFs) {
    await l.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setFullScreen(true)
    )
    await expect.poll(() => winFs(l), { timeout: 8_000 }).toBe(true)
  }
  await l.page.waitForTimeout(1_500)
  const before = await snap(l)
  expect(before.visible).toEqual({ sidebar: true, composer: true, tileTabs: true })
  await guest(l, 'void document.documentElement.requestFullscreen(), 1')
  await expect.poll(() => guest(l, '!!document.fullscreenElement'), { timeout: 5_000 }).toBe(true)
  await l.page.waitForTimeout(1_000)
  return before
}

/** everything is back: window, embedder, guest, layout, hit-testing */
async function expectRestored(
  l: LaunchedApp,
  before: Snap,
  opts: { guestAlive?: boolean } = {}
): Promise<void> {
  const guestAlive = opts.guestAlive ?? true
  await expect
    .poll(() => winFs(l), { timeout: 4_000, message: 'window isFullScreen' })
    .toBe(before.winFullScreen)
  await expect
    .poll(() => embedderFs(l), { timeout: 4_000, message: 'embedder fullscreenElement' })
    .toBe(false)
  if (guestAlive)
    await expect
      .poll(() => guest(l, '!!document.fullscreenElement'), {
        timeout: 4_000,
        message: 'guest fullscreenElement'
      })
      .toBe(false)
  await l.page.waitForTimeout(500)
  const after = await snap(l)
  expect(after.visible, 'sidebar/composer/tabs hit-testable').toEqual({
    sidebar: true,
    composer: true,
    tileTabs: true
  })
  if (guestAlive) expect(after.webview.rect, 'webview rect').toEqual(before.webview.rect)
}

const fsStateRaw = async (l: LaunchedApp): Promise<string> =>
  JSON.stringify({
    win: await winFs(l),
    emb: await embedderFs(l),
    guest: await guest(l, '!!document.fullscreenElement')
  })

for (const pre of [false, true]) {
  const tag = pre ? ' (window already fullscreen before guest)' : ''

  test(`guest document.exitFullscreen() restores the app${tag}`, async () => {
    launched = await launchApp()
    const before = await enter(launched, pre)
    await guest(launched, 'void document.exitFullscreen(), 1')
    await expectRestored(launched, before)
    if (!pre) {
      // sustained: embedder fullscreenElement null + chrome hit-testable for 7 s straight
      const end = Date.now() + 7_000
      while (Date.now() < end) {
        expect(await embedderFs(launched)).toBe(false)
        expect((await snap(launched)).visible).toEqual({
          sidebar: true,
          composer: true,
          tileTabs: true
        })
        await launched.page.waitForTimeout(500)
      }
    }
  })

  test(`green-button path: win.setFullScreen(false) during guest fullscreen${tag}`, async () => {
    launched = await launchApp()
    const before = await enter(launched, pre)
    await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setFullScreen(false)
    )
    // green button always leaves native fullscreen -> window ends NOT fullscreen
    await expect.poll(() => winFs(launched!), { timeout: 4_000 }).toBe(false)
    await expect.poll(() => embedderFs(launched!), { timeout: 4_000 }).toBe(false)
    await expect
      .poll(() => guest(launched!, '!!document.fullscreenElement'), { timeout: 4_000 })
      .toBe(false)
    await launched.page.waitForTimeout(500)
    const after = await snap(launched)
    expect(after.visible).toEqual({ sidebar: true, composer: true, tileTabs: true })
    void before
  })

  test(`closing the browser tab while guest is fullscreen restores the app${tag}`, async () => {
    launched = await launchApp()
    const before = await enter(launched, pre)
    // DOM click: a coordinate click would land on the fullscreen webview, not the tab strip
    expect(
      await launched.page.evaluate(() => {
        const b = document.querySelector('.browser-tab .browser-tab-close') as HTMLElement | null
        b?.click()
        return !!b
      })
    ).toBe(true)
    await expect
      .poll(() => fsStateRaw(launched!).catch(() => 'ERR'), { timeout: 5_000 })
      .toContain('"win":' + before.winFullScreen)
    await expectRestored(launched, before, { guestAlive: false })
  })
}

for (const via of ['sendInputEvent'] as const) {
  for (const pre of [false, true]) {
    const name = `Escape (${via}) during guest fullscreen restores the app${pre ? ' (window already fullscreen)' : ''}`
    // Windowed case: a synthetic Escape wedges main even with guestFullscreen unhooked
    // (control run), so it measures Electron/the harness, not this app.
    const run = pre ? test : test.fixme
    run(name, async () => {
      launched = await launchApp()
      const before = await enter(launched, pre)
      await launched.app.evaluate(({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview')!
        wc.focus()
        // deferred: return from evaluate first so a main-thread wedge can't eat the reply
        setTimeout(() => {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        }, 50)
      })
      // main not wedged: after the unwind has had time to run, a trivial evaluate answers within 3 s
      await launched.page.waitForTimeout(1_500).catch(() => {})
      expect(
        await Promise.race([
          launched.app.evaluate(() => 'pong'),
          new Promise((r) => setTimeout(() => r('WEDGED'), 3_000))
        ]),
        'main process responsive after Escape'
      ).toBe('pong')
      await expectRestored(launched, before)
    })
  }

  test(`Escape (${via}) in a NON-fullscreen guest page still reaches the page`, async () => {
    launched = await launchApp()
    await openBrowser(launched.page, await serve())
    await expect.poll(() => guest(launched!, 'document.readyState')).toBe('complete')
    await launched.page.waitForTimeout(500)
    await guest(launched, 'window.__keys.length = 0, 1')
    if (via === 'sendInputEvent') {
      await launched.app.evaluate(({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview')!
        wc.focus()
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      })
    } else {
      await launched.app.evaluate(({ webContents }) => {
        webContents
          .getAllWebContents()
          .find((w) => w.getType() === 'webview')!
          .focus()
      })
      await launched.page.keyboard.press('Escape')
    }
    await expect
      .poll(() => guest(launched!, 'JSON.stringify(window.__keys)'), { timeout: 4_000 })
      .toContain('Escape')
  })
}
