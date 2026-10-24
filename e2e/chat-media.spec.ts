import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaUrl } from '../src/shared/mediaUrl'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Agent-created media renders inline in chat: tool-result image blocks, markdown
 * images, bare media paths in prose, Write of an image, video. The fake agent's
 * `media demo <dir>` directive emits all of them (fakeAdapter.ts).
 *
 * "Visible" is not enough for an image: every assertion is on naturalWidth > 0
 * (decoded) or readyState >= 1 (video metadata arrived over the scheme).
 */

const SHOTS = process.env.HANG4R_MEDIA_SHOTS ?? ''

let launched: LaunchedApp
let dir: string
let page: Page
let sid: string
let tile: ReturnType<Page['locator']>
const pageRequests: string[] = []
let guestServer: Server
let guestPort = 0

function ffmpeg(...args: string[]): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' })
}

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, name) })
}

/** every <img> matching `sel` inside `root` is decoded (not just present) */
async function decoded(root: ReturnType<Page['locator']>, sel: string, min = 1): Promise<void> {
  await expect
    .poll(
      async () =>
        root
          .locator(sel)
          .evaluateAll((els) =>
            els.filter((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0).length
          ),
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(min)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hang4r-media-'))
  // real, decodable files: an orange 200x120 PNG and a 1s H.264 mp4
  ffmpeg('-f', 'lavfi', '-i', 'color=c=orange:s=200x120', '-frames:v', '1', join(dir, 'shot.png'))
  ffmpeg(
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'clip.mp4')
  )
  // a local web page for the browser-pane isolation test
  guestServer = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>guest</title><h1>guest page</h1>')
  })
  await new Promise<void>((r) => guestServer.listen(0, '127.0.0.1', r))
  const addr = guestServer.address()
  guestPort = typeof addr === 'object' && addr ? addr.port : 0

  launched = await launchApp()
  page = launched.page
  page.on('request', (r) => pageRequests.push(r.url()))
  // main-process view too: every request the default session makes
  await launched.app.evaluate(({ session }) => {
    const g = globalThis as unknown as { __mediaReqs: string[] }
    g.__mediaReqs = []
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      g.__mediaReqs.push(d.url)
      cb({})
    })
  })
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill(`media demo ${dir}`)
  await page.getByRole('button', { name: /Start agent/ }).click()
  tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
})

test.afterAll(async () => {
  await launched?.app.close().catch(() => {})
  await new Promise((r) => guestServer?.close(r))
})

test('markdown ![](abs path) decodes via hang4r-media://', async () => {
  const img = tile.locator('.msg-assistant img.chat-media-img[alt="shot"], .msg-assistant img.chat-media-img[title$="shot.png"]')
  await decoded(tile.locator('.msg-assistant'), 'img.chat-media-img')
  const info = await tile
    .locator('.msg-assistant img.chat-media-img')
    .first()
    .evaluate((e) => ({
      src: (e as HTMLImageElement).src,
      w: (e as HTMLImageElement).naturalWidth,
      h: (e as HTMLImageElement).naturalHeight
    }))
  expect(info.src.startsWith('hang4r-media://local/')).toBe(true)
  expect(decodeURIComponent(info.src.split('/').pop() as string)).toBe(join(dir, 'shot.png'))
  expect([info.w, info.h]).toEqual([200, 120])
  void img
})

test('prose path to an mp4 becomes a <video> whose metadata loaded over the scheme', async () => {
  const video = tile.locator('.chat-media-prose video')
  await expect(video).toHaveCount(1)
  await video.scrollIntoViewIfNeeded()
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)
  const v = await video.evaluate((e) => {
    const m = e as HTMLVideoElement
    return { src: m.src, w: m.videoWidth, h: m.videoHeight, d: m.duration, controls: m.controls, err: m.error?.code ?? null }
  })
  expect(v.src.startsWith('hang4r-media://local/')).toBe(true)
  expect([v.w, v.h]).toEqual([160, 120])
  expect(v.d).toBeGreaterThan(0.5)
  expect(v.controls).toBe(true)
  expect(v.err).toBeNull()
})

test('a seek issues a Range request that the scheme honours (206)', async () => {
  const url = await tile.locator('.chat-media-prose video').evaluate((v) => (v as HTMLVideoElement).src)
  // fetch is gated by the page CSP (connect-src → default 'self'), so go through
  // the main process: net.fetch on the same session routes to the protocol handler
  const r = await launched.app.evaluate(async ({ session }, u) => {
    const res = await session.defaultSession.fetch(u, { headers: { range: 'bytes=0-9' } })
    const body = (await res.arrayBuffer()).byteLength
    const bad = await session.defaultSession.fetch(u, { headers: { range: 'bytes=99999999-' } })
    return {
      status: res.status,
      cr: res.headers.get('content-range'),
      type: res.headers.get('content-type'),
      body,
      badStatus: bad.status
    }
  }, url)
  expect(r.status).toBe(206)
  expect(r.cr).toMatch(/^bytes 0-9\/\d+$/)
  expect(r.type).toBe('video/mp4')
  expect(r.body).toBe(10)
  expect(r.badStatus).toBe(416)
})

test('the scheme serves media only: non-media ext, traversal-ish and UNC are refused', async () => {
  writeFileSync(join(dir, 'secret.txt'), 'nope')
  const res = await launched.app.evaluate(
    async ({ session }, urls) => {
      const out: Record<string, number> = {}
      for (const [k, u] of Object.entries(urls)) out[k] = (await session.defaultSession.fetch(u)).status
      return out
    },
    {
      txt: mediaUrl(join(dir, 'secret.txt')),
      missing: mediaUrl(join(dir, 'nope.png')),
      unc: mediaUrl('//evil.host/a.png'),
      rel: mediaUrl('relative/a.png'),
      ok: mediaUrl(join(dir, 'shot.png'))
    }
  )
  expect(res).toEqual({ txt: 403, missing: 404, unc: 403, rel: 403, ok: 200 })
})

test('a missing ![](abs path) shows the "file no longer exists" chip; a missing prose path shows nothing', async () => {
  // needs the fake agent's demo message to include ![stale](<dir>/stale.png) (never created)
  const msg = tile.locator('.msg-assistant').filter({ hasText: 'Here is the capture' })
  const chip = tile.locator('.chat-media-missing')
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('file no longer exists')
  await expect(chip).toContainText(join(dir, 'stale.png'))
  // the prose mention of gone.png is quiet: no chip, no image, no request for it
  await expect(msg.locator('.chat-media-prose .chat-media-chip')).toHaveCount(0)
  await expect(msg.locator('.chat-media-prose')).not.toContainText('gone.png')
})

test('https and //host markdown images are chips and never fetched', async () => {
  const msg = tile.locator('.msg-assistant').filter({ hasText: 'Here is the capture' })
  const chips = msg.locator('.chat-media-chip')
  await expect(chips.filter({ hasText: 'remote' })).toHaveCount(1)
  await expect(chips.filter({ hasText: 'unc' })).toHaveCount(1)
  // no <img> was ever created for them
  expect(await msg.locator('img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src))).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/example\.com|evil\.host/)])
  )
  // give the lazy/IO paths time to (wrongly) fire, then check both request logs
  await page.waitForTimeout(1000)
  const mainReqs = await launched.app.evaluate(() => (globalThis as unknown as { __mediaReqs: string[] }).__mediaReqs)
  expect(mainReqs.length).toBeGreaterThan(0) // the listener is actually live
  const all = [...pageRequests, ...mainReqs]
  expect(all.filter((u) => /example\.com|evil\.host/.test(u))).toEqual([])
  // the page itself did request our scheme, so the probe can see it
  expect(all.some((u) => u.startsWith('hang4r-media://'))).toBe(true)
})

test('tool-result image: collapsed group shows a decoded thumbnail; click opens the Lightbox', async () => {
  const group = tile.locator('.activity-group').first()
  await expect(group.locator('.activity-header')).toContainText('Worked')
  await decoded(group, 'img.chat-media-img')
  await group.scrollIntoViewIfNeeded()
  await shot('01-chat-with-media.png')
  // a collapsed group caps at 4 and says how many it hid
  const thumbs = await group.locator(':scope > .chat-media img.chat-media-img').count()
  expect(thumbs).toBeLessThanOrEqual(4)
  await group.locator(':scope > .chat-media img.chat-media-img').first().click()
  const box = page.locator('.lightbox-backdrop')
  await expect(box).toBeVisible()
  const lb = box.locator('img.lightbox-img')
  await expect(lb).toBeVisible()
  expect(await lb.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await shot('02-lightbox-image.png')
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
})

test('expanded group: thumbnails under the Read and Write rows; JSON shows [image N KB], never base64', async () => {
  const group = tile.locator('.activity-group').first()
  await group.locator('.activity-header').click()
  const rows = group.locator('.activity-body .tool-row')
  const read = rows.filter({ has: page.locator('.tool-name', { hasText: /^Read$/ }) })
  await read.scrollIntoViewIfNeeded() // thumbnails are lazy: only fetched once near the viewport
  await decoded(read, 'img.chat-media-img')
  // Write row with an image file_path gets a file-backed thumbnail
  const write = rows.filter({ hasText: 'written.png' })
  await expect(write).toHaveCount(1)
  await write.scrollIntoViewIfNeeded()
  await decoded(write, 'img.chat-media-img')
  // expand the Read row's detail
  await read.locator('.tool-name').click() // the path span opens the file instead of toggling
  const detail = read.locator('.tool-row-detail')
  await expect(detail).toContainText('[image')
  const txt = await detail.innerText()
  expect(txt).toMatch(/\[image \d+(\.\d)? (KB|MB)\]/)
  expect(txt).not.toContain('iVBOR')
  expect(txt.length).toBeLessThan(2000)
  await read.scrollIntoViewIfNeeded()
  await shot('03-expanded-group.png')
})

test('Subagents thread shows the tool-result image too', async () => {
  await tile.getByRole('button', { name: 'Subagents' }).click()
  const view = tile.locator('.subagents-view')
  await expect(view).toBeVisible()
  await decoded(view, 'img.chat-media-img')
  await view.locator('.subagent-tool-row, .tool-row').first().scrollIntoViewIfNeeded()
  const pre = await view.locator('pre').allInnerTexts()
  expect(pre.join('\n')).not.toContain('iVBOR')
  await shot('04-subagents-thread.png')
  await tile.getByRole('button', { name: 'Subagents' }).click() // close panel
})

test('video: enlarge opens the Lightbox with a playing-capable <video>', async () => {
  const wrap = tile.locator('.chat-media-video').first()
  await wrap.scrollIntoViewIfNeeded()
  await wrap.hover()
  await wrap.locator('.chat-media-expand').click()
  const v = page.locator('.lightbox-backdrop video.lightbox-img')
  await expect(v).toBeVisible()
  await expect
    .poll(() => v.evaluate((e) => (e as HTMLVideoElement).readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)
  await shot('05-lightbox-video.png')
  await page.keyboard.press('Escape')
  await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
})

test('browser-pane partition cannot reach hang4r-media://', async () => {
  const mediaSrc = mediaUrl(join(dir, 'shot.png')) // the exact URL the main window loads fine

  await tile.locator('.tile-tabs button', { hasText: 'Browser' }).click()
  await page.locator('.browser-url').fill(`127.0.0.1:${guestPort}`)
  await page.locator('.browser-url').press('Enter')
  const wv = page.locator('.browser-webview')
  await expect(wv).toHaveCount(1)
  // wait for the guest page to be real
  await expect
    .poll(
      () => wv.evaluate((w) => (w as unknown as { executeJavaScript(s: string): Promise<string> }).executeJavaScript('document.title')).catch(() => ''),
      { timeout: 20_000 }
    )
    .toBe('guest')
  const probe = await wv.evaluate(
    (w, u) =>
      (w as unknown as { executeJavaScript(s: string): Promise<unknown> }).executeJavaScript(`
        (async () => {
          const f = await fetch(${JSON.stringify(u)}).then(r => 'resolved:' + r.status, e => 'rejected:' + e.message)
          const img = await new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = ${JSON.stringify(u)} })
          return { f, img }
        })()
      `),
    mediaSrc
  )
  // never a resolved 200, never a decoded image
  expect((probe as { f: string }).f).toMatch(/^rejected:/)
  expect((probe as { img: string }).img).toBe('error')
  await shot('06-browser-pane.png')
})

async function waitIdle(id: string): Promise<void> {
  await expect
    .poll(async () => (await page.evaluate(() => window.hang4r.listSessions())).find((x) => x.id === id)?.status, {
      timeout: 30_000
    })
    .toBe('idle')
}

test('caps: a collapsed group shows 4 thumbnails + "+2 more"; prose shows 6 + "+2 more"', async () => {
  const { copyFileSync } = await import('node:fs')
  for (let i = 1; i <= 8; i++) copyFileSync(join(dir, 'shot.png'), join(dir, `many${i}.png`))
  await page.evaluate(([id, d]) => window.hang4r.prompt(id, `media many ${d}`), [sid, dir])
  await expect(tile.locator('.msg-assistant', { hasText: 'Eight shots' })).toBeVisible({ timeout: 20_000 })
  await waitIdle(sid)
  // a group that was the live tail while the turn ran stays open (useState(defaultOpen)
  // never re-closes); a reload mounts it settled, i.e. collapsed
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'media demo' }).last().click()
  tile = page.locator('.tile').first()
  await expect(tile.locator('.msg-assistant', { hasText: 'Eight shots' })).toBeVisible({ timeout: 20_000 })
  const group = tile.locator('.activity-group').filter({ hasText: 'many6.png' })
  await group.scrollIntoViewIfNeeded()
  await expect(group.locator('.activity-header')).toContainText('▸') // collapsed
  await decoded(group, ':scope > .chat-media img.chat-media-img', 4)
  await expect(group.locator(':scope > .chat-media img.chat-media-img')).toHaveCount(4)
  await expect(group.locator(':scope > .chat-media > .chat-media-more')).toHaveText('+2 more')
  const prose = tile.locator('.msg-assistant', { hasText: 'Eight shots' }).locator('.chat-media-prose')
  await prose.scrollIntoViewIfNeeded()
  await decoded(prose, 'img.chat-media-img', 6)
  await expect(prose.locator('img.chat-media-img')).toHaveCount(6)
  await expect(prose.locator('.chat-media-more')).toHaveText('+2 more')
  await shot('08-caps.png')
})

test('lazy: media far above the viewport is a placeholder (no fetch) until scrolled near', async () => {
  const project = (await page.evaluate(() => window.hang4r.listSessions()))[0].projectId
  const s2 = await page.evaluate(
    ({ pid, d }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'lazy-media',
        firstPrompt: `media demo ${d}`
      }),
    { pid: project, d: dir }
  )
  await waitIdle(s2.id)
  for (let i = 0; i < 12; i++) {
    await page.evaluate((id) => window.hang4r.prompt(id, 'filler turn'), s2.id)
    await waitIdle(s2.id)
  }
  const before = pageRequests.length
  await page.locator('.session-row', { hasText: 'lazy-media' }).click()
  tile = page.locator('.tile').first()
  await expect(tile.locator('.activity-group').last()).toBeVisible({ timeout: 20_000 })
  // the media turn is the first in the transcript — well outside the viewport
  const ph = tile.locator('.chat-media-ph')
  await expect(ph.first()).toBeAttached()
  const mediaFetched = pageRequests.slice(before).filter((u) => u.startsWith('hang4r-media://'))
  expect(mediaFetched).toEqual([])
  const imgsAbove = await tile.locator('.msg-assistant img.chat-media-img, .chat-media-prose video').count()
  expect(imgsAbove).toBe(0)
  // scroll the transcript to its top → the placeholders upgrade to decoded images
  await tile.locator('.chat-scroll, .chat').first().evaluate((el) => {
    const sc = [el, ...el.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 50 && getComputedStyle(n).overflowY !== 'visible') as HTMLElement | undefined
    if (sc) sc.scrollTop = 0
  })
  await decoded(tile.locator('.msg-assistant'), 'img.chat-media-img')
  await shot('09-lazy-scrolled.png')
})

test('after a reload the windowed loader still renders thumbnails, video and chips', async () => {
  await page.evaluate(() => window.hang4r.setSetting('openTurns', '2'))
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'media demo' }).last().click()
  tile = page.locator('.tile').first()
  await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
  // lazy media: bring the demo turn's message into view first
  await tile.locator('.msg-assistant', { hasText: 'Here is the capture' }).scrollIntoViewIfNeeded()
  await decoded(tile.locator('.msg-assistant', { hasText: 'Here is the capture' }), 'img.chat-media-img')
  await expect(tile.locator('.chat-media-prose video')).toHaveCount(1)
  await expect
    .poll(() => tile.locator('.chat-media-prose video').evaluate((v) => (v as HTMLVideoElement).readyState), {
      timeout: 15_000
    })
    .toBeGreaterThanOrEqual(1)
  await expect(tile.locator('.chat-media-missing')).toHaveCount(1)
  const group = tile.locator('.activity-group').first()
  await group.scrollIntoViewIfNeeded()
  await decoded(group, 'img.chat-media-img')
  await shot('07-after-reload.png')
  void sid
})

test('narrow window: media stays inside the chat column (no horizontal overflow)', async () => {
  await launched.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(960, 820) // the window's minimum
  })
  await tile.getByRole('button', { name: 'Subagents' }).click() // side panel squeezes the chat column further
  await page.waitForTimeout(500)
  await tile.locator('.msg-assistant', { hasText: 'Here is the capture' }).scrollIntoViewIfNeeded()
  const over = await tile.evaluate((t) => {
    const right = (t.querySelector('.msg-assistant') as HTMLElement).getBoundingClientRect().right
    const bad = [...t.querySelectorAll(':is(.msg-assistant, .activity-group) :is(.chat-media-img, .chat-media-video video, .chat-media-chip)')]
      .map((e) => ({ cls: (e as HTMLElement).className, r: e.getBoundingClientRect().right }))
      .filter((x) => x.r > right + 1)
    return { vw: innerWidth, right, bad }
  })
  await shot('10-narrow.png')
  expect(over.vw).toBeLessThanOrEqual(960)
  expect(over.bad).toEqual([])
})

test('files that did not exist at first render appear once the miss expires (~31 s): quiet prose and the mounted chip both re-check', async () => {
  test.setTimeout(90_000)
  const msg = tile.locator('.msg-assistant', { hasText: 'Here is the capture' })
  await msg.scrollIntoViewIfNeeded()
  // before: gone.png renders nothing, stale.png is the single chip
  await expect(tile.locator('.chat-media-missing')).toHaveCount(1)
  await expect(msg.locator('.chat-media-prose img[title$="gone.png"]')).toHaveCount(0)
  // the agent "creates" both later; the renderer's 30 s miss cache then expires
  copyFileSync(join(dir, 'shot.png'), join(dir, 'gone.png'))
  copyFileSync(join(dir, 'shot.png'), join(dir, 'stale.png'))
  await expect(msg.locator('img.chat-media-img[title$="stale.png"], img.chat-media-img[alt="stale.png"]')).toHaveCount(1, {
    timeout: 45_000
  })
  await expect(tile.locator('.chat-media-missing')).toHaveCount(0)
  await decoded(msg, 'img.chat-media-img[title$="gone.png"]')
  await decoded(msg, 'img.chat-media-img[title$="stale.png"]')
})
