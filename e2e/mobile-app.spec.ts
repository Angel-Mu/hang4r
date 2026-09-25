import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'
import {
  applyEvent,
  canEditUser,
  emptyTranscript,
  userOccurrences,
  type Item
} from '../mobile/src/state/transcript'

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
  // the CLI-resolved model (init) is captured per session and persisted
  await expect
    .poll(() =>
      phone.evaluate(() =>
        Object.values(
          JSON.parse(localStorage.getItem('h4.sessionInit') ?? '{}') as Record<
            string,
            { model: string }
          >
        ).map((v) => v.model)
      )
    )
    .toContain('fake-model')

  // composer grows with multiline text up to its CSS cap, shrinks after send
  const composer = phone.locator('.composer-input')
  const composerH = (): Promise<number> =>
    composer.evaluate((el) => Math.round(el.getBoundingClientRect().height))
  const oneLineH = await composerH()
  await composer.fill('one\ntwo\nthree')
  await expect.poll(composerH).toBeGreaterThan(oneLineH + 20)
  await composer.fill(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'))
  await expect.poll(composerH).toBe(132)

  // keyboard backdrop follows the composer only while it has focus
  await composer.focus()
  await expect(phone.locator('html')).toHaveClass(/\bkb-composer\b/)
  await composer.blur()
  await expect(phone.locator('html')).not.toHaveClass(/\bkb-composer\b/)

  // drive a new turn from the phone and watch it stream
  await phone.fill('.composer-input', 'stream me something\nover two lines')
  await expect.poll(composerH).toBeGreaterThan(oneLineH)
  await phone.click('.composer .btn-primary')
  await expect.poll(composerH).toBe(oneLineH)
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
  // review comment from the phone: tap a line, comment, send — the desktop
  // turns it into a follow-up prompt (a new turn)
  await phone.locator('.diff-line-tappable').first().click()
  await phone.fill('.diff-compose textarea', 'please rename this export')
  await phone.click('.diff-compose .btn-primary')
  await phone.click('.review-bar .btn-primary')
  await expect(phone.locator('.review-bar')).toHaveCount(0, { timeout: 15_000 })
  await phone.click('.view-toggle')
  await expect(phone.locator('.msg-user').last()).toContainText('please rename this export', {
    timeout: 30_000
  })

  const pngPath = join(repo, 'tiny.png')
  writeFileSync(
    pngPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  )

  // start a brand-new session from the phone, with an image on the first prompt
  await phone.click('.push-screen .back-btn') // ‹ Back → home (panel slides out)
  await phone.click('.topbar-new')
  await expect(phone.locator('.form-screen')).toBeVisible()
  await phone.selectOption('.form-field >> nth=0', project.id)
  // every Claude alias carries today's lineup version
  for (const label of ['Opus 5.5', 'Sonnet 5', 'Fable 5.1', 'Haiku 4.5']) {
    await expect(phone.locator('.form-screen option', { hasText: label })).toHaveCount(1)
  }
  await phone.click('.segment-item:has-text("Local")')
  await phone.fill('.form-textarea', 'second session from the phone')
  await phone.setInputFiles('.form-screen .attach-btn input[type=file]', pngPath)
  await expect(phone.locator('.form-screen .pending-image img')).toHaveCount(1, {
    timeout: 10_000
  })
  await phone.click('.form-screen .btn-primary')
  await expect(phone.locator('.msg-user')).toContainText('second session from the phone', {
    timeout: 30_000
  })
  await expect(phone.locator('.msg-user .msg-images img')).toHaveCount(1)
  await expect
    .poll(async () => (await desktop.evaluate(() => window.hang4r.listSessions())).length)
    .toBe(2)
  const firstTurnImages = await desktop.evaluate(async () => {
    const all = await window.hang4r.listSessions()
    const s = all.find((x) => x.title.includes('second session')) ?? all[all.length - 1]
    const evs = await window.hang4r.getSessionEvents(s.id)
    const u = evs.find((e) => e.event.kind === 'user-text')?.event
    return u && 'images' in u ? (u.images?.length ?? 0) : 0
  })
  expect(firstTurnImages).toBe(1)

  // attach an image: picked file downscales on-device and rides the prompt
  await phone.setInputFiles('.attach-btn input[type=file]', pngPath)
  await expect(phone.locator('.pending-image img')).toHaveCount(1, { timeout: 10_000 })
  await phone.fill('.composer-input', 'look at this screenshot')
  await phone.click('.composer .btn-primary')
  await expect(phone.locator('.msg-user .msg-images img').first()).toBeVisible({
    timeout: 30_000
  })

  // session info sheet: change the model, desktop reflects it
  await phone.click('[aria-label="Session info"]')
  await expect(phone.locator('.sheet option', { hasText: 'Opus 5.5' })).toHaveCount(1)
  await phone.selectOption('.sheet select', 'sonnet')
  await expect
    .poll(
      async () =>
        (await desktop.evaluate(() => window.hang4r.listSessions())).find(
          (x) => x.title.includes('second session')
        )?.model ?? (await desktop.evaluate(() => window.hang4r.listSessions()))[0]?.model,
      { timeout: 15_000 }
    )
    .toBe('sonnet')
  await phone.click('.sheet-scrim')

  // settings screen shows the paired computer online (via the drawer now)
  await phone.click('.push-screen .back-btn') // back home (panel slides out)
  await phone.click('.brand-btn')
  await phone.click('.drawer [aria-label="Settings"]')
  await expect(phone.locator('.usage-card').first()).toContainText('online', { timeout: 15_000 })
})

/** Desktop (fake agent) + phone paired through the relay, one session started
 *  with `firstPrompt` and opened on the phone. Closed by the test's teardown. */
async function pairedSession(
  firstPrompt: string
): Promise<{ desktop: Page; phone: Page; teardown: () => Promise<void> }> {
  const app = await launchApp()
  const desktop = app.page
  await desktop.evaluate(() => window.hang4r.bridgeSetEnabled(true))
  const pairing = await desktop.evaluate(() => window.hang4r.bridgePairing())
  await expect
    .poll(async () => (await desktop.evaluate(() => window.hang4r.bridgeStatus())).relayConnected, {
      timeout: 15_000
    })
    .toBe(true)
  const project = await createProject(desktop, makeScratchRepo())
  await desktop.evaluate(
    ({ projectId, firstPrompt }) =>
      window.hang4r.createSession({
        projectId,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        firstPrompt
      }),
    { projectId: project.id, firstPrompt }
  )
  const b = await chromium.launch()
  const phone = await b.newPage({ viewport: { width: 390, height: 844 } })
  await phone.goto(`http://localhost:${PREVIEW_PORT}/`)
  await phone.fill('.pair-input', pairing.url)
  await phone.click('button:has-text("Pair with this computer")')
  await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
  await expect(phone.locator('.session-row')).toHaveCount(1, { timeout: 15_000 })
  await phone.locator('.session-row').click()
  await expect(phone.locator('.msg-user').first()).toContainText(firstPrompt, { timeout: 15_000 })
  return {
    desktop,
    phone,
    teardown: async () => {
      await b.close().catch(() => {})
      await app.app.close().catch(() => {})
    }
  }
}

test('phone: prose options become quick replies that send the letter', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(120_000)
  const { phone, teardown } = await pairedSession('offer me options')
  try {
    const card = phone.locator('.quick-replies')
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card.locator('.quick-replies-title')).toHaveText('Which scope should the sweep use?')
    await expect(card.locator('.quick-reply')).toHaveCount(3)
    await card.locator('.quick-reply', { hasText: 'Only addresses on the dashboard' }).click()
    await expect(phone.locator('.msg-user').nth(1)).toHaveText('B', { timeout: 15_000 })
    // the next turn's last words are not a question — the options go away
    await expect(card).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await teardown()
  }
})

test('phone: the task list shows progress above the composer and opens as a sheet', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(120_000)
  const { phone, teardown } = await pairedSession('write a checklist')
  try {
    const pill = phone.locator('.task-progress')
    await expect(pill).toBeVisible({ timeout: 15_000 })
    await expect(pill.locator('.task-progress-count')).toHaveText('Tasks 2/4')
    await pill.click()
    const sheet = phone.locator('.task-sheet')
    await expect(sheet.locator('.todo-row')).toHaveCount(4)
    await expect(sheet.locator('.todo-completed')).toHaveCount(2)
    await expect(sheet.locator('.todo-row').nth(2)).toContainText('3. Approval API')
    await phone.click('.sheet-scrim')
    await expect(sheet).toHaveCount(0)
  } finally {
    await teardown()
  }
})

test('phone: questions answer in one tap, and a turn ending kills an open one', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(120_000)
  const { phone, teardown } = await pairedSession('ask a question')
  try {
    // single single-choice question: tapping an option IS the answer
    const first = phone.locator('.question-card').first()
    await expect(first.locator('.btn-option')).toHaveCount(2, { timeout: 15_000 })
    await expect(first.locator('button', { hasText: 'Answer' })).toHaveCount(0)
    await first.locator('.btn-option', { hasText: 'Blue' }).click()
    await expect(first.locator('.question-answer')).toHaveText('Answered: Blue', { timeout: 15_000 })
    await expect(first.locator('.btn-option')).toHaveCount(0)

    // a second question, then Stop: the turn ends, the card must go dead
    await expect(phone.locator('.composer .btn-primary')).toBeVisible({ timeout: 15_000 })
    await phone.fill('.composer-input', 'ask a question again')
    await phone.click('.composer .btn-primary')
    const second = phone.locator('.question-card').nth(1)
    await expect(second.locator('.btn-option')).toHaveCount(2, { timeout: 15_000 })
    await phone.click('.composer .btn-danger')
    await expect(second.locator('.question-answer')).toContainText('Cancelled', { timeout: 15_000 })
    await expect(second.locator('button')).toHaveCount(0)
    // and the list stops claiming the session needs you
    await phone.click('.push-screen .back-btn')
    await expect(phone.locator('.session-row')).toHaveCount(1)
    await expect(phone.locator('.session-row .needs-you')).toHaveCount(0)
  } finally {
    await teardown()
  }
})

test('phone: follow-ups queue while the agent works and go one per turn', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  // a held permission keeps the turn running — a stable window to queue into
  const { desktop, phone, teardown } = await pairedSession('ask permission to start')
  try {
    await expect(phone.locator('.perm-card', { hasText: 'Approval needed' })).toBeVisible({
      timeout: 15_000
    })
    const queueBtn = phone.locator('.composer .btn-primary')
    await expect(queueBtn).toHaveText('Queue')
    await expect(phone.locator('.composer .btn-danger')).toHaveText('Stop')
    for (const text of ['QUEUED ALPHA', 'QUEUED BETA', 'QUEUED GAMMA']) {
      await phone.fill('.composer-input', text)
      await queueBtn.click()
    }
    const rows = phone.locator('.queue-row')
    await expect(rows).toHaveCount(3)
    await expect(phone.locator('.queue-count')).toHaveText('3 Queued')
    await expect(phone.locator('.composer-input')).toHaveValue('')

    await rows.filter({ hasText: 'QUEUED GAMMA' }).getByLabel('Remove from queue').click()
    await expect(rows).toHaveCount(2)
    // edit pulls the text back into the composer; queueing it again puts it last
    await rows.filter({ hasText: 'QUEUED ALPHA' }).getByLabel('Edit queued message').click()
    await expect(phone.locator('.composer-input')).toHaveValue('QUEUED ALPHA')
    await expect(rows).toHaveCount(1)
    await queueBtn.click()
    await expect(rows.nth(0)).toContainText('QUEUED BETA')
    await expect(rows.nth(1)).toContainText('QUEUED ALPHA')

    // the queue survives a reload
    await phone.reload()
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await phone.locator('.session-row').click()
    await expect(rows).toHaveCount(2, { timeout: 15_000 })
    await expect(phone.locator('.msg-user')).toHaveCount(1)

    // the turn settles → one message per turn, oldest first, exactly once each
    await phone.locator('.perm-card .btn-primary', { hasText: 'Allow' }).click()
    await expect(rows).toHaveCount(0, { timeout: 30_000 })
    await expect(phone.locator('.msg-user')).toHaveCount(3, { timeout: 30_000 })
    await expect(phone.locator('.msg-user').nth(1)).toHaveText('QUEUED BETA')
    await expect(phone.locator('.msg-user').nth(2)).toHaveText('QUEUED ALPHA')
    await expect(phone.locator('.turn-divider')).toHaveCount(3, { timeout: 30_000 })
    const userTexts = async (): Promise<string[]> =>
      desktop.evaluate(async () => {
        const [s] = await window.hang4r.listSessions()
        const evs = await window.hang4r.getSessionEvents(s.id)
        return evs.flatMap((e) => (e.event.kind === 'user-text' ? [e.event.text] : []))
      })
    expect(await userTexts()).toEqual(['ask permission to start', 'QUEUED BETA', 'QUEUED ALPHA'])

    // Send now: interrupts the live turn and delivers straight away
    await phone.fill('.composer-input', 'ask permission again')
    await phone.locator('.composer .btn-primary').click()
    const held = phone.locator('.perm-card', { hasText: 'Approval needed' })
    await expect(held).toBeVisible({ timeout: 15_000 })
    await phone.fill('.composer-input', 'SEND ME NOW')
    await queueBtn.click()
    await rows.filter({ hasText: 'SEND ME NOW' }).getByLabel('Send now').click()
    await expect(phone.locator('.msg-user').last()).toHaveText('SEND ME NOW', { timeout: 30_000 })
    await expect(rows).toHaveCount(0)
    await expect(held).toHaveCount(0)
    await expect.poll(userTexts, { timeout: 15_000 }).toEqual([
      'ask permission to start',
      'QUEUED BETA',
      'QUEUED ALPHA',
      'ask permission again',
      'SEND ME NOW'
    ])
  } finally {
    await teardown()
  }
})

test('phone: a queue left behind is sent once, in turn, when the phone comes back', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { desktop, phone, teardown } = await pairedSession('ask permission to start')
  try {
    await expect(phone.locator('.perm-card', { hasText: 'Approval needed' })).toBeVisible({
      timeout: 15_000
    })
    for (const text of ['LATER ONE', 'LATER TWO']) {
      await phone.fill('.composer-input', text)
      await phone.locator('.composer .btn-primary').click()
    }
    await expect(phone.locator('.queue-row')).toHaveCount(2)

    // the phone goes away; the turn ends on the desktop without it
    await phone.goto('about:blank')
    const sessionId = await desktop.evaluate(async () => (await window.hang4r.listSessions())[0].id)
    await desktop.evaluate(async (id) => {
      const evs = await window.hang4r.getSessionEvents(id)
      const req = evs.find((e) => e.event.kind === 'permission-request')?.event
      if (req && 'requestId' in req) await window.hang4r.respondPermission(id, req.requestId, 'allow')
    }, sessionId)
    await expect
      .poll(async () => (await desktop.evaluate(() => window.hang4r.listSessions()))[0].status, {
        timeout: 15_000
      })
      .toBe('idle')

    // back: the settle was never heard, so coming online flushes — one message
    // per turn, never two into the same one
    await phone.goto(`http://localhost:${PREVIEW_PORT}/`)
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    const flow = async (): Promise<string[]> =>
      desktop.evaluate(async (id) => {
        const evs = await window.hang4r.getSessionEvents(id)
        return evs.flatMap((e) =>
          e.event.kind === 'user-text' ? [e.event.text] : e.event.kind === 'turn-complete' ? ['|'] : []
        )
      }, sessionId)
    await expect
      .poll(flow, { timeout: 30_000 })
      .toEqual(['ask permission to start', '|', 'LATER ONE', '|', 'LATER TWO', '|'])
  } finally {
    await teardown()
  }
})

/** Desktop (fake agent, optional env) with one workspace and the given
 *  sessions, and a phone paired to it sitting on the home list. */
async function pairedHome(
  specs: { title: string; firstPrompt?: string; projectIndex?: number; backend?: string }[],
  opts: {
    env?: Record<string, string>
    projects?: number
    /** runs on the desktop after the sessions exist, before the phone pairs */
    beforePair?: (desktop: Page, projectIds: string[], ids: string[]) => Promise<void>
    /** runs on the phone page before the app loads */
    phoneSetup?: (phone: Page) => Promise<void>
  } = {}
): Promise<{
  desktop: Page
  phone: Page
  projectIds: string[]
  ids: string[]
  teardown: () => Promise<void>
}> {
  const app = await launchApp({ env: opts.env })
  const desktop = app.page
  await desktop.evaluate(() => window.hang4r.bridgeSetEnabled(true))
  const pairing = await desktop.evaluate(() => window.hang4r.bridgePairing())
  await expect
    .poll(async () => (await desktop.evaluate(() => window.hang4r.bridgeStatus())).relayConnected, {
      timeout: 15_000
    })
    .toBe(true)
  const projectIds: string[] = []
  for (let i = 0; i < (opts.projects ?? 1); i++) {
    projectIds.push((await createProject(desktop, makeScratchRepo())).id)
  }
  await desktop.reload()
  await desktop.waitForSelector('.app')
  const ids: string[] = []
  for (const spec of specs) {
    const s = await desktop.evaluate(
      ({ projectId, title, firstPrompt, backend }) =>
        window.hang4r.createSession({
          projectId,
          backend: backend as 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title,
          ...(firstPrompt ? { firstPrompt } : {})
        }),
      {
        projectId: projectIds[spec.projectIndex ?? 0],
        title: spec.title,
        firstPrompt: spec.firstPrompt,
        backend: spec.backend ?? 'claude'
      }
    )
    ids.push(s.id)
  }
  for (const [i, spec] of specs.entries()) {
    if (!spec.firstPrompt) continue
    await expect
      .poll(
        async () =>
          (await desktop.evaluate(() => window.hang4r.listSessions())).find((x) => x.id === ids[i])
            ?.status,
        { timeout: 20_000 }
      )
      .toMatch(/^(idle|error)$/)
  }
  await opts.beforePair?.(desktop, projectIds, ids)
  const b = await chromium.launch()
  const phone = await b.newPage({ viewport: { width: 390, height: 844 } })
  await opts.phoneSetup?.(phone)
  await phone.goto(`http://localhost:${PREVIEW_PORT}/`)
  await phone.fill('.pair-input', pairing.url)
  await phone.click('button:has-text("Pair with this computer")')
  await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
  await expect(phone.locator('.session-row').first()).toBeVisible({ timeout: 15_000 })
  return {
    desktop,
    phone,
    projectIds,
    ids,
    teardown: async () => {
      await b.close().catch(() => {})
      await app.app.close().catch(() => {})
    }
  }
}

const SHOTS = '/private/tmp/claude-501/mobile-round-18-shots'

test('phone: the bell is the desktop bell — lit by it, cleared by a desktop open, blind to metadata', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { desktop, phone, ids, teardown } = await pairedHome([
    { title: 'alpha', firstPrompt: 'do the thing' }
  ])
  try {
    const bell = phone.locator('.session-row', { hasText: 'alpha' }).locator('.session-bell')
    await expect(bell).toBeVisible({ timeout: 15_000 })
    await phone.screenshot({ path: `${SHOTS}/3-bell-from-desktop.png` })

    // opened on the desktop → the phone's bell goes too
    const desktopRow = desktop.locator('.session-row', { hasText: 'alpha' })
    await desktopRow.click()
    await expect(bell).toHaveCount(0, { timeout: 15_000 })

    // rename + model change bump updatedAt; neither is a finished turn
    await desktop.evaluate((id) => window.hang4r.renameSession(id, 'alpha renamed'), ids[0])
    await desktop.evaluate((id) => window.hang4r.setSessionModel(id, 'sonnet'), ids[0])
    const renamed = phone.locator('.session-row', { hasText: 'alpha renamed' })
    await expect(renamed).toBeVisible({ timeout: 15_000 })
    await expect(renamed.locator('.session-bell')).toHaveCount(0)
    await phone.reload()
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await expect(renamed).toBeVisible()
    await expect(renamed.locator('.session-bell')).toHaveCount(0)

    // marked unread on the desktop while the phone is away → there on return
    await phone.goto('about:blank')
    await desktop.locator('.session-row', { hasText: 'alpha renamed' }).click({ button: 'right' })
    await desktop.locator('.ctx-menu .ctx-item', { hasText: 'Mark as unread' }).click()
    await phone.goto(`http://localhost:${PREVIEW_PORT}/`)
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await expect(renamed.locator('.session-bell')).toBeVisible({ timeout: 15_000 })

    // …and opened on the desktop while the phone is away → gone on return
    await phone.goto('about:blank')
    await desktop.locator('.session-row', { hasText: 'alpha renamed' }).click()
    await phone.goto(`http://localhost:${PREVIEW_PORT}/`)
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await expect(renamed.locator('.session-bell')).toHaveCount(0, { timeout: 15_000 })
    await phone.screenshot({ path: `${SHOTS}/3-seen-on-desktop-while-away.png` })
  } finally {
    await teardown()
  }
})

test('phone: an older desktop still gets bells from finished turns, not from metadata', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { desktop, phone, ids, teardown } = await pairedHome([{ title: 'legacy' }], {
    env: { HANG4R_TEST_BRIDGE_WITHOUT: 'sidebarState,markUnseen' }
  })
  try {
    const row = phone.locator('.session-row', { hasText: 'legacy' })
    await expect(row.locator('.session-bell')).toHaveCount(0)
    await desktop.evaluate((id) => window.hang4r.prompt(id, 'do a turn'), ids[0])
    await expect(row.locator('.session-bell')).toBeVisible({ timeout: 20_000 })
    await row.click()
    await phone.click('.push-screen .back-btn')
    await expect(row.locator('.session-bell')).toHaveCount(0)
    // a cold start first, so no echo of that look is still in flight
    await phone.reload()
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await desktop.evaluate((id) => window.hang4r.renameSession(id, 'legacy renamed'), ids[0])
    const renamed = phone.locator('.session-row', { hasText: 'legacy renamed' })
    await expect(renamed).toBeVisible({ timeout: 15_000 })
    await expect(renamed.locator('.session-bell')).toHaveCount(0)
    await phone.reload()
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await expect(renamed).toBeVisible()
    await expect(renamed.locator('.session-bell')).toHaveCount(0)
  } finally {
    await teardown()
  }
})

test('phone: workspaces and sessions come in the desktop sidebar order, offline too', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { desktop, phone, projectIds, teardown } = await pairedHome(
    [
      { title: 'p0 older', projectIndex: 0 },
      { title: 'p0 newer', projectIndex: 0 },
      { title: 'p1 only', projectIndex: 1 },
      { title: 'p2 only', projectIndex: 2 }
    ],
    {
      projects: 4,
      beforePair: async (desktop, pids, ids) => {
        // activity alone would say p2, p1, p0 — the desktop says otherwise
        await desktop.evaluate(
          ({ pids, ids }) =>
            Promise.all([
              window.hang4r.setSetting('pinnedProjects', JSON.stringify([pids[1]])),
              window.hang4r.setSetting('projectOrder', JSON.stringify([pids[3], pids[0], pids[2]])),
              window.hang4r.setSetting('pinnedSessions', JSON.stringify([ids[0]])),
              window.hang4r.setSetting('collapsedProjects', JSON.stringify([pids[2]]))
            ]),
          { pids, ids }
        )
        await desktop.reload()
        await desktop.waitForSelector('.app')
      }
    }
  )
  try {
    const desktopOrder = await desktop.locator('.project-row .project-name').allTextContents()
    const phoneOrder = phone.locator('.project-header .project-name')
    await expect(phoneOrder).toHaveCount(4, { timeout: 15_000 })
    expect(await phoneOrder.allTextContents()).toEqual(desktopOrder)
    const names = await desktop.evaluate(async (pids) => {
      const all = await window.hang4r.listProjects()
      return pids.map((id) => all.find((p) => p.id === id)!.name)
    }, projectIds)
    // pinned p1, then the drag order (empty p3 included), then p2 as sorted
    expect(desktopOrder).toEqual([names[1], names[3], names[0], names[2]])
    // the desktop's session pin wins over recency; its collapse applies
    const p0 = phone.locator('.project-group').nth(2)
    await expect(p0.locator('.session-title')).toHaveText(['p0 older', 'p0 newer'])
    await expect(
      desktop.locator('.sidebar .project-group').nth(2).locator('.session-title')
    ).toHaveText(['p0 older', 'p0 newer'])
    await expect(p0.locator('.session-row').first().locator('.session-pin')).toBeVisible()
    await expect(phone.locator('.project-group').nth(3).locator('.session-row')).toHaveCount(0)
    await expect(phone.locator('.project-group').nth(0).locator('.project-pin')).toBeVisible()
    await phone.screenshot({ path: `${SHOTS}/7-desktop-order.png` })

    // desktop goes away: a cold start still shows its order
    await desktop.evaluate(() => window.hang4r.bridgeSetEnabled(false))
    await phone.reload()
    await expect(phone.locator('.conn-online')).toHaveCount(0)
    await expect(phoneOrder).toHaveCount(4, { timeout: 15_000 })
    expect(await phoneOrder.allTextContents()).toEqual(desktopOrder)
  } finally {
    await teardown()
  }
})

test('phone: an older desktop keeps the activity order, empty workspaces hidden', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { phone, projectIds, desktop, teardown } = await pairedHome(
    [
      { title: 'first made', projectIndex: 0 },
      { title: 'last made', projectIndex: 1 }
    ],
    {
      projects: 3,
      env: { HANG4R_TEST_BRIDGE_WITHOUT: 'sidebarState,markUnseen' },
      beforePair: (desktop, pids) =>
        desktop.evaluate(
          (pids) => window.hang4r.setSetting('projectOrder', JSON.stringify([pids[0], pids[1]])),
          pids
        )
    }
  )
  try {
    const names = await desktop.evaluate(async (pids) => {
      const all = await window.hang4r.listProjects()
      return pids.map((id) => all.find((p) => p.id === id)!.name)
    }, projectIds)
    await expect(phone.locator('.project-header .project-name')).toHaveText([names[1], names[0]], {
      timeout: 15_000
    })
    await expect(phone.locator('.banner-error')).toHaveCount(0)
  } finally {
    await teardown()
  }
})

/** hold a row the way a finger does: the sheet opens on the timer, not on release */
async function longPress(phone: Page, text: string): Promise<void> {
  const row = phone.locator('.session-row', { hasText: text })
  await row.dispatchEvent('touchstart')
  await expect(phone.locator('.session-actions-sheet')).toBeVisible()
  await row.dispatchEvent('touchend')
}

test('phone: long-press opens row actions — read, unread and pin, mirrored on the desktop', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { desktop, phone, teardown } = await pairedHome([
    { title: 'gamma', firstPrompt: 'do the thing' }
  ])
  try {
    const row = phone.locator('.session-row', { hasText: 'gamma' })
    const desktopFlag = desktop
      .locator('.session-row', { hasText: 'gamma' })
      .locator('.session-flag-finished')
    await expect(row.locator('.session-bell')).toBeVisible({ timeout: 15_000 })
    await expect(desktopFlag).toBeVisible()

    await longPress(phone, 'gamma')
    const sheet = phone.locator('.session-actions-sheet')
    await expect(sheet.locator('.sheet-action')).toHaveText(['Pin to top', 'Mark as read'])
    // the click a long-press release can produce is not a choice
    await phone.locator('.sheet-scrim').dispatchEvent('click')
    await expect(sheet).toBeVisible()
    await sheet.locator('.sheet-action').first().dispatchEvent('click')
    await expect(sheet).toBeVisible()
    await expect(row.locator('.session-pin')).toHaveCount(0)
    await phone.screenshot({ path: `${SHOTS}/8-row-actions.png` })
    await sheet.locator('.sheet-action', { hasText: 'Mark as read' }).click()
    await expect(sheet).toHaveCount(0)
    await expect(row.locator('.session-bell')).toHaveCount(0)
    await expect(desktopFlag).toHaveCount(0, { timeout: 15_000 })

    await longPress(phone, 'gamma')
    await sheet.locator('.sheet-action', { hasText: 'Mark as unread' }).click()
    await expect(row.locator('.session-bell')).toBeVisible()
    await expect(desktopFlag).toBeVisible({ timeout: 15_000 })

    await longPress(phone, 'gamma')
    await sheet.locator('.sheet-action', { hasText: 'Pin to top' }).click()
    await expect(row.locator('.session-pin')).toBeVisible()
    // a tap after a long-press opens the row again
    await row.click()
    await expect(phone.locator('.msg-user').first()).toContainText('do the thing', {
      timeout: 15_000
    })
    await expect(desktopFlag).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await teardown()
  }
})

test('phone: an older desktop can still be marked unread, on the phone alone', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { phone, teardown } = await pairedHome([{ title: 'delta' }], {
    env: { HANG4R_TEST_BRIDGE_WITHOUT: 'sidebarState,markUnseen' }
  })
  try {
    const row = phone.locator('.session-row', { hasText: 'delta' })
    const sheet = phone.locator('.session-actions-sheet')
    await expect(row.locator('.session-bell')).toHaveCount(0)
    await longPress(phone, 'delta')
    await sheet.locator('.sheet-action', { hasText: 'Mark as unread' }).click()
    await expect(row.locator('.session-bell')).toBeVisible()
    await phone.reload()
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await expect(row.locator('.session-bell')).toBeVisible()
    await longPress(phone, 'delta')
    await sheet.locator('.sheet-action', { hasText: 'Mark as read' }).click()
    await expect(row.locator('.session-bell')).toHaveCount(0)
    await expect(phone.locator('.banner-error')).toHaveCount(0)
  } finally {
    await teardown()
  }
})

test('phone: status dots, times and rollups match the desktop sidebar', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(180_000)
  const { desktop, phone, ids, teardown } = await pairedHome([
    { title: 'bg worker', firstPrompt: 'spawn background agents' },
    { title: 'broken', firstPrompt: 'trigger error' },
    { title: 'finisher', firstPrompt: 'do the thing' },
    { title: 'asker' }
  ])
  try {
    // seen on the desktop, so its accent no longer outranks the cyan
    await desktop.locator('.session-row', { hasText: 'bg worker' }).click()
    await desktop.locator('.session-row', { hasText: 'asker' }).click()
    await desktop.evaluate(
      (id) => window.hang4r.prompt(id, 'please ask permission before proceeding'),
      ids[3]
    )
    const phoneRow = (t: string) => phone.locator('.session-row', { hasText: t })
    await expect(phoneRow('bg worker').locator('.status-dot')).toHaveClass(/status-pending/, {
      timeout: 20_000
    })
    await expect(phoneRow('asker').locator('.needs-you')).toBeVisible({ timeout: 20_000 })
    // every row's dot is the desktop's dot
    for (const t of ['bg worker', 'broken', 'finisher', 'asker']) {
      const want = await desktop
        .locator('.sidebar .session-row', { hasText: t })
        .locator('.status-dot')
        .getAttribute('class')
      await expect(phoneRow(t).locator('.status-dot')).toHaveAttribute('class', want!)
    }
    await expect(phoneRow('finisher').locator('.session-time')).toHaveText('now')
    await phone.screenshot({ path: `${SHOTS}/9-status-dots.png` })

    // the reason a session failed, one long-press away
    const lastError = (await desktop.evaluate(() => window.hang4r.listSessions())).find(
      (x) => x.id === ids[1]
    )!.lastError
    expect(lastError).toBeTruthy()
    await longPress(phone, 'broken')
    await expect(phone.locator('.session-actions-sheet .sheet-error')).toHaveText(lastError!)
    await phone.screenshot({ path: `${SHOTS}/9-last-error.png` })
    await phone.locator('.sheet-scrim').click()

    // a collapsed workspace still says what's inside
    await phone.locator('.project-header').first().click()
    const header = phone.locator('.project-header').first()
    await expect(header.locator('.needs-you-count')).toHaveText('1 need you')
    await expect(header.locator('.project-flag-error')).toHaveText('1 error')
    await expect(header.locator('.project-flag-finished')).toHaveText('1 done')
    await phone.screenshot({ path: `${SHOTS}/9-rollups.png` })
    await phone.locator('.project-header').first().click()

    // "needs you" survives a cold start
    await phone.reload()
    await expect(phoneRow('asker').locator('.needs-you')).toBeVisible()
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await expect(phoneRow('asker').locator('.needs-you')).toBeVisible()
    await expect(phoneRow('bg worker').locator('.status-dot')).toHaveClass(/status-pending/, {
      timeout: 15_000
    })

    await phone.setViewportSize({ width: 1024, height: 1366 })
    await phone.screenshot({ path: `${SHOTS}/9-ipad-status.png` })
  } finally {
    await teardown()
  }
})

test('phone: edit keys match the desktop, and outside-CLI messages have none', () => {
  const t = emptyTranscript()
  const ev = (seq: number, event: Parameters<typeof applyEvent>[1]['event']): void => {
    applyEvent(t, { sessionId: 's', seq, ts: seq, event })
  }
  ev(1, { kind: 'user-text', text: 'again' })
  ev(2, { kind: 'external-turn', role: 'user', text: 'again', at: 2 })
  ev(3, { kind: 'user-text', text: ' again ' })
  ev(4, { kind: 'user-text', text: 'other' })
  ev(5, { kind: 'user-text', text: '— resumed: 3 earlier messages' })
  const users = t.items.filter((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user')
  expect(users.map(canEditUser)).toEqual([true, false, true, true, false])
  const occ = userOccurrences(t.items)
  // only user-text events count — the desktop's rewind never matches the rest
  expect(users.map((u) => occ.get(u))).toEqual([1, undefined, 0, 0, 0])
})

async function waitIdle(desktop: Page, id: string): Promise<void> {
  await expect
    .poll(
      async () => (await desktop.evaluate(() => window.hang4r.listSessions())).find((x) => x.id === id)?.status,
      { timeout: 20_000 }
    )
    .toBe('idle')
}

test('phone: edit a sent message — the conversation restarts from it, cache included', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { desktop, phone, ids, teardown } = await pairedHome(
    [{ title: 'rewinder', firstPrompt: 'first message alpha', backend: 'codex' }],
    {
      beforePair: async (desktop, _pids, ids) => {
        await desktop.evaluate((id) => window.hang4r.prompt(id, 'second message beta'), ids[0])
        await waitIdle(desktop, ids[0])
      }
    }
  )
  try {
    await phone.locator('.session-row', { hasText: 'rewinder' }).click()
    const users = phone.locator('.msg-user')
    await expect(users).toHaveCount(2, { timeout: 15_000 })
    await expect(phone.locator('.msg-edit-btn')).toHaveCount(2)
    await phone.screenshot({ path: `${SHOTS}/4-edit-affordance.png` })

    await phone.locator('.msg-edit-btn').first().click()
    const input = phone.locator('.msg-edit-input')
    await expect(input).toHaveValue('first message alpha')
    await expect(phone.locator('.msg-edit-hint')).toContainText('later messages are discarded')
    await phone.getByRole('button', { name: 'Cancel' }).click()
    await expect(input).toHaveCount(0)
    await expect(users).toHaveCount(2)

    await phone.locator('.msg-edit-btn').first().click()
    await input.fill('edited first gamma')
    await phone.screenshot({ path: `${SHOTS}/4-edit-editor.png` })
    await phone.getByRole('button', { name: 'Send from here' }).click()

    await expect(input).toHaveCount(0, { timeout: 15_000 })
    await expect(users).toHaveText(['edited first gamma'], { timeout: 15_000 })
    await expect(phone.locator('.turn-divider')).toHaveCount(1, { timeout: 15_000 })
    await phone.screenshot({ path: `${SHOTS}/4-edit-result.png` })
    const texts = async (): Promise<string[]> =>
      (await desktop.evaluate((id) => window.hang4r.getSessionEvents(id), ids[0]))
        .map((e) => e.event)
        .filter((e) => e.kind === 'user-text')
        .map((e) => (e as { text: string }).text)
    expect(await texts()).toEqual(['edited first gamma'])

    // edited on the desktop: the open phone is told, not left appending
    await desktop.evaluate(
      (id) => window.hang4r.rewindSession(id, 'edited first gamma', 0, 'desktop delta'),
      ids[0]
    )
    await expect(users).toHaveText(['desktop delta'], { timeout: 15_000 })
    await expect(phone.locator('.turn-divider')).toHaveCount(1, { timeout: 15_000 })
    expect(await texts()).toEqual(['desktop delta'])

    const cachedUsers = (): Promise<string[]> =>
      phone.evaluate((id) => {
        const cache = JSON.parse(localStorage.getItem('h4.transcripts.v1') ?? '{}') as Record<
          string,
          { items: { kind: string; text?: string }[] }
        >
        return (cache[id]?.items ?? []).filter((i) => i.kind === 'user').map((i) => i.text ?? '')
      }, ids[0])
    await expect.poll(cachedUsers).toEqual(['desktop delta'])
    await phone.reload()
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await phone.locator('.session-row', { hasText: 'rewinder' }).click()
    await expect(users).toHaveText(['desktop delta'], { timeout: 15_000 })
    expect(await cachedUsers()).toEqual(['desktop delta'])
  } finally {
    await teardown()
  }
})

test('phone: editing on an older desktop says what to update; Cursor resends as a new turn', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { phone, teardown } = await pairedHome(
    [{ title: 'old desk', firstPrompt: 'first message alpha', backend: 'cursor' }],
    { env: { HANG4R_TEST_BRIDGE_WITHOUT: 'rewindSession' } }
  )
  try {
    await phone.locator('.session-row', { hasText: 'old desk' }).click()
    await expect(phone.locator('.msg-user')).toHaveCount(1, { timeout: 15_000 })
    await phone.locator('.msg-edit-btn').click()
    await expect(phone.locator('.msg-edit-hint')).toContainText('as a new turn; the earlier messages stay')
    await phone.locator('.msg-edit-input').fill('edited first gamma')
    await phone.getByRole('button', { name: 'Resend as new turn' }).click()
    await expect(phone.locator('.msg-edit-error')).toHaveText(
      'Needs a newer hang4r on your computer — update it and retry.'
    )
    await phone.screenshot({ path: `${SHOTS}/4-edit-needs-desktop.png` })
    await phone.getByRole('button', { name: 'Cancel' }).click()
    await expect(phone.locator('.msg-user')).toHaveText(['first message alpha'])
  } finally {
    await teardown()
  }
})

/** a session with `turns` prompts ('turn 1'…), all finished before the phone pairs */
function longSession(turns: number): Parameters<typeof pairedHome>[1]['beforePair'] {
  return async (desktop, _pids, ids) => {
    for (let n = 2; n <= turns; n++) {
      await desktop.evaluate(([id, t]) => window.hang4r.prompt(id, t), [ids[0], `turn ${n}`])
      await waitIdle(desktop, ids[0])
    }
  }
}

test('phone: a long conversation opens on its latest turns and loads older ones scrolling up', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(240_000)
  const turns = 10
  const { phone, teardown } = await pairedHome(
    [{ title: 'long one', firstPrompt: 'turn 1' }],
    { env: { HANG4R_TEST_BRIDGE_PAGE_BYTES: '6000' }, beforePair: longSession(turns) }
  )
  try {
    await phone.locator('.session-row', { hasText: 'long one' }).click()
    const users = phone.locator('.msg-user')
    await expect(users.last()).toHaveText(`turn ${turns}`, { timeout: 15_000 })
    const firstCount = await users.count()
    expect(firstCount).toBeLessThan(turns)
    await expect(phone.locator('.older-loader')).toBeVisible()
    await phone.screenshot({ path: `${SHOTS}/6-paged-open.png` })

    // the newest message's element must survive every prepend (stable keys)
    await users.last().evaluate((el) => el.setAttribute('data-probe', 'newest'))
    const transcript = phone.locator('.transcript')
    let count = firstCount
    while (count < turns) {
      const firstText = await users.first().innerText()
      // at the top: where the first loaded message sits on screen
      const before = await transcript.evaluate((el, text) => {
        el.scrollTop = 0
        const m = [...el.querySelectorAll('.msg-user')].find((x) => x.textContent === text)!
        return m.getBoundingClientRect().top
      }, firstText)
      await expect.poll(() => users.count(), { timeout: 20_000 }).toBeGreaterThan(count)
      count = await users.count()
      // …and it is still there after the older page landed above it
      const after = await transcript.evaluate((el, text) => {
        const m = [...el.querySelectorAll('.msg-user')].find((x) => x.textContent === text)!
        return m.getBoundingClientRect().top
      }, firstText)
      expect(Math.abs(after - before)).toBeLessThan(4)
    }
    await expect(users).toHaveText(Array.from({ length: turns }, (_, i) => `turn ${i + 1}`))
    await expect(phone.locator('.older-loader')).toHaveCount(0)
    await expect(phone.locator('[data-probe="newest"]')).toHaveText(`turn ${turns}`)
    await transcript.evaluate((el) => (el.scrollTop = 0))
    await phone.screenshot({ path: `${SHOTS}/6-paged-all.png` })
  } finally {
    await teardown()
  }
})

test('phone: a reconnect keeps the older turns already scrolled in', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(240_000)
  const turns = 8
  const { desktop, phone, ids, teardown } = await pairedHome(
    [{ title: 'long one', firstPrompt: 'turn 1' }],
    { env: { HANG4R_TEST_BRIDGE_PAGE_BYTES: '6000' }, beforePair: longSession(turns) }
  )
  try {
    await phone.locator('.session-row', { hasText: 'long one' }).click()
    const users = phone.locator('.msg-user')
    await expect(users.last()).toHaveText(`turn ${turns}`, { timeout: 15_000 })
    const firstCount = await users.count()
    const more = phone.getByRole('button', { name: 'Load earlier messages' })
    await more.click({ timeout: 10_000 })
    await expect.poll(() => users.count(), { timeout: 20_000 }).toBeGreaterThan(firstCount)
    const loaded = await users.allInnerTexts()
    expect(loaded.length).toBeLessThan(turns)

    const savedAt = (): Promise<number> =>
      phone.evaluate(
        (id) =>
          (JSON.parse(localStorage.getItem('h4.transcripts.v1') ?? '{}') as Record<
            string,
            { savedAt: number }
          >)[id]?.savedAt ?? 0,
        ids[0]
      )
    const before = await savedAt()
    // the desktop drops off and comes back: the phone replays the transcript
    const offline = phone.locator('.composer-input[placeholder="desktop offline"]')
    await desktop.evaluate(() => window.hang4r.bridgeSetEnabled(false))
    await expect(offline).toBeVisible({ timeout: 30_000 })
    await desktop.evaluate(() => window.hang4r.bridgeSetEnabled(true))
    await expect(offline).toHaveCount(0, { timeout: 45_000 })
    await expect.poll(savedAt, { timeout: 30_000 }).toBeGreaterThan(before)
    expect(await users.allInnerTexts()).toEqual(loaded)
    await expect(more).toBeVisible()
  } finally {
    await teardown()
  }
})

test('phone: an older desktop without paging still opens the whole conversation', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { phone, teardown } = await pairedHome([{ title: 'old desk', firstPrompt: 'turn 1' }], {
    env: { HANG4R_TEST_BRIDGE_WITHOUT: 'getSessionEventsPage' },
    beforePair: longSession(3)
  })
  try {
    await phone.locator('.session-row', { hasText: 'old desk' }).click()
    await expect(phone.locator('.msg-user')).toHaveText(['turn 1', 'turn 2', 'turn 3'], {
      timeout: 15_000
    })
    await expect(phone.locator('.older-loader')).toHaveCount(0)
    await expect(phone.locator('.stale-note')).toHaveCount(0)
  } finally {
    await teardown()
  }
})

test('phone: a slow history download is waited for, not called a dead link', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(150_000)
  const { phone, teardown } = await pairedHome([{ title: 'slow', firstPrompt: 'turn 1' }], {
    env: { HANG4R_TEST_BRIDGE_DELAY: 'getSessionEventsPage=25000,getSessionEvents=25000' }
  })
  try {
    await phone.locator('.session-row', { hasText: 'slow' }).click()
    await expect(phone.locator('.skeleton-stack')).toBeVisible()
    await expect(phone.locator('.msg-user')).toHaveText(['turn 1'], { timeout: 60_000 })
    await expect(phone.locator('.stale-note')).toHaveCount(0)
    await expect(phone.locator('.conn-online')).toBeVisible()
  } finally {
    await teardown()
  }
})

test('phone: a link that goes quiet while in the foreground is probed and replaced', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(120_000)
  let deafSocket = 0
  let sockets = 0
  const { phone, teardown } = await pairedHome([{ title: 'quiet one' }], {
    phoneSetup: async (p) => {
      await p.addInitScript(() =>
        localStorage.setItem('h4.testLinkTiming', JSON.stringify({ silence: 4000, tick: 1000 }))
      )
      // a proxy that can stop delivering: the socket stays OPEN, nothing arrives
      await p.routeWebSocket(/\/client\//, (ws) => {
        const id = ++sockets
        const server = ws.connectToServer()
        server.onMessage((m) => {
          if (id !== deafSocket) ws.send(m)
        })
      })
    }
  })
  try {
    await phone.click('.brand-btn')
    await phone.click('.drawer [aria-label="Settings"]')
    const card = phone.locator('.conn-diag')
    await expect(card.locator('[data-diag="state"]')).toContainText('online')
    const before = sockets
    deafSocket = sockets
    await expect.poll(() => sockets, { timeout: 30_000 }).toBeGreaterThan(before)
    await expect(card.locator('[data-diag="state"]')).toContainText('online', { timeout: 20_000 })
    await expect(card).toContainText('nothing received for 4s — probing')
    await expect(card.locator('[data-diag="close"]')).toContainText('probe unanswered')
    await expect(card.locator('[data-diag="reconnects"]')).not.toHaveText('0')
    // the desktop's hello reaches a phone that arrived after it
    await expect(card.locator('[data-diag="peer"]')).toHaveText(/^hang4r \S+$/)
    await phone.screenshot({ path: `${SHOTS}/10-phone-connection.png`, fullPage: true })
    const copied = await phone.evaluate(async () => {
      let text = ''
      navigator.clipboard.writeText = async (t: string): Promise<void> => {
        text = t
      }
      ;[...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Copy connection details')!
        .click()
      await new Promise((r) => setTimeout(r, 200))
      return text
    })
    expect(copied).toContain('hang4r bridge — phone')
    expect(copied).toContain('probe unanswered')
  } finally {
    await teardown()
  }
})

test('phone: after a re-pair on the computer, the old pairing says to scan the QR again', async () => {
  test.skip(!MOBILE_BUILT, 'mobile app not built')
  test.setTimeout(120_000)
  const { desktop, phone, teardown } = await pairedHome([{ title: 'repair one' }], {
    env: { HANG4R_TEST_BRIDGE_TIMING: 'ping=1000' }
  })
  try {
    const banner = phone.locator('.banner-pairing')
    const fresh = await desktop.evaluate(() => window.hang4r.bridgeRepair())
    // still connected: the desktop now speaks a key this phone doesn't hold
    await expect(banner).toBeVisible({ timeout: 30_000 })
    await expect(banner).toContainText('Pairing may have changed on your computer — scan the QR again')
    // a cold start with the stale pairing: the relay refuses every socket
    await phone.reload()
    await expect(phone.locator('.session-row').first()).toBeVisible()
    await expect(banner).toBeVisible({ timeout: 45_000 })
    await phone.screenshot({ path: `${SHOTS}/10-phone-repair.png` })
    await banner.getByRole('button', { name: 'Scan QR again' }).click()
    await phone.fill('.pair-input', fresh.url)
    await phone.click('button:has-text("Pair with this computer")')
    await expect(phone.locator('.conn-online')).toBeVisible({ timeout: 30_000 })
    await expect(banner).toHaveCount(0)
  } finally {
    await teardown()
  }
})
