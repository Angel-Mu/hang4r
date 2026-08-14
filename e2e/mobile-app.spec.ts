import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

// Real-relay, real-mobile-build full-system test (not part of the fake-agent
// regression gate). It needs the mobile app built (vite preview serves its dist)
// and the deployed relay reachable — self-skip when the build is absent so the
// desktop suite stays deterministic instead of failing on a missing precondition.
const MOBILE_BUILT = existsSync(join(__dirname, '..', 'mobile', 'dist', 'index.html'))

/**
 * Full-system test: the REAL mobile web app (built dist, served by vite
 * preview) in Chromium, paired to the REAL desktop app through the DEPLOYED
 * relay. Requires `npm run build` in mobile/ first (vite preview serves dist).
 */
const PREVIEW_PORT = 4173

let preview: ChildProcess
let launched: LaunchedApp
let browser: Browser
let phone: Page

test.beforeAll(async () => {
  if (!MOBILE_BUILT) return
  preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: join(__dirname, '..', 'mobile'),
    stdio: 'ignore'
  })
  await expect
    .poll(
      async () => {
        try {
          const res = await fetch(`http://localhost:${PREVIEW_PORT}/`)
          return res.ok
        } catch {
          return false
        }
      },
      { timeout: 20_000 }
    )
    .toBe(true)
})

test.afterAll(async () => {
  await browser?.close()
  await launched?.app.close()
  preview?.kill()
})

test('phone app pairs, sees sessions, drives a conversation, approves', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built — run `cd mobile && npm run build` (real-relay full-system test)')
  test.setTimeout(180_000)
  launched = await launchApp()
  const desktop = launched.page

  await desktop.evaluate(() => window.hang4r.bridgeSetEnabled(true))
  const pairing = await desktop.evaluate(() => window.hang4r.bridgePairing())
  await expect
    .poll(async () => (await desktop.evaluate(() => window.hang4r.bridgeStatus())).relayConnected, {
      timeout: 15_000
    })
    .toBe(true)

  const repo = makeScratchRepo()
  const project = await createProject(desktop, repo)
  await desktop.evaluate(
    (projectId) =>
      window.hang4r.createSession({
        projectId,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        firstPrompt: 'hello from the desktop'
      }),
    project.id
  )

  browser = await chromium.launch()
  phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await phone.goto(`http://localhost:${PREVIEW_PORT}/`)

  // pair (by paste — the scan button is a separate primary action)
  await phone.fill('.pair-input', pairing.url)
  await phone.click('button:has-text("Pair with this computer")')

  // home: connected + the session listed
  await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
  const row = phone.locator('.session-row')
  await expect(row).toHaveCount(1, { timeout: 15_000 })

  // open session: transcript replays the first turn
  await row.click()
  await expect(phone.locator('.msg-user')).toContainText('hello from the desktop', {
    timeout: 15_000
  })
  await expect(phone.locator('.msg-assistant').first()).toBeVisible()

  // drive a new turn from the phone and watch it stream
  await phone.fill('.composer-input', 'stream me something')
  await phone.click('.composer .btn-primary')
  await expect(phone.locator('.msg-user').nth(1)).toContainText('stream me something')
  await expect(phone.locator('.turn-divider')).toHaveCount(2, { timeout: 30_000 })

  // permission approval from the phone
  await phone.fill('.composer-input', 'now ask permission please')
  await phone.click('.composer .btn-primary')
  const permCard = phone.locator('.perm-card', { hasText: 'Approval needed' })
  await expect(permCard).toBeVisible({ timeout: 30_000 })
  await permCard.locator('.btn-primary', { hasText: 'Allow' }).click()
  await expect(phone.locator('.perm-resolved')).toContainText('Allowed', { timeout: 15_000 })

  // the desktop's transcript saw the same permission resolution
  const sessions = await desktop.evaluate(() => window.hang4r.listSessions())
  const events = await desktop.evaluate(
    (id) => window.hang4r.getSessionEvents(id),
    sessions[0].id
  )
  expect(events.some((e) => e.event.kind === 'permission-resolved')).toBe(true)

  // diff review: change a file on disk, open the ± view, drill into the patch
  appendFileSync(join(repo, 'src', 'index.js'), 'export const fromPhoneTest = 2\n')
  await phone.click('.view-toggle')
  const fileRow = phone.locator('.diff-file-row', { hasText: 'src/index.js' })
  await expect(fileRow).toBeVisible({ timeout: 15_000 })
  await fileRow.click()
  await expect(phone.locator('.diff-view')).toContainText('fromPhoneTest', { timeout: 15_000 })
  await phone.click('.diff-back')
  await phone.click('.view-toggle')

  // start a brand-new session from the phone
  await phone.click('.push-screen .back-btn') // ‹ Back → home (panel slides out)
  await phone.click('.topbar-new')
  await expect(phone.locator('.form-screen')).toBeVisible()
  await phone.selectOption('.form-field >> nth=0', project.id)
  await phone.click('.segment-item:has-text("Local")')
  await phone.fill('.form-textarea', 'second session from the phone')
  await phone.click('.form-screen .btn-primary')
  await expect(phone.locator('.msg-user')).toContainText('second session from the phone', {
    timeout: 30_000
  })
  await expect
    .poll(async () => (await desktop.evaluate(() => window.hang4r.listSessions())).length)
    .toBe(2)

  // settings screen shows the paired computer online (via the drawer now)
  await phone.click('.push-screen .back-btn') // back home (panel slides out)
  await phone.click('.brand-btn')
  await phone.click('.drawer [aria-label="Settings"]')
  await expect(phone.locator('.usage-card').first()).toContainText('online', { timeout: 15_000 })
})
