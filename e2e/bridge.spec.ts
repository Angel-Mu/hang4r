import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'
import { FakePhone } from './bridgeClient'
import type { SessionEvent, SessionMeta, Project } from '../src/shared/protocol'
import type { BridgeDesktopFrame, BridgeSidebarState } from '../src/shared/bridge'
import type { Page } from '@playwright/test'

async function pairPhone(page: Page): Promise<FakePhone> {
  await page.evaluate(() => window.hang4r.bridgeSetEnabled(true))
  const pairing = await page.evaluate(() => window.hang4r.bridgePairing())
  await expect
    .poll(async () => (await page.evaluate(() => window.hang4r.bridgeStatus())).relayConnected, {
      timeout: 15_000
    })
    .toBe(true)
  const p = new FakePhone(pairing.url)
  await p.connectWithRetry()
  await expect
    .poll(async () => (await page.evaluate(() => window.hang4r.bridgeStatus())).phoneConnected, {
      timeout: 15_000
    })
    .toBe(true)
  return p
}

const frameFor =
  (t: 'seen' | 'unseen', sessionId: string) =>
  (f: BridgeDesktopFrame): boolean =>
    f.t === t && f.sessionId === sessionId

// Talks to the DEPLOYED relay (network required) — the point is proving the
// real desktop↔relay↔phone loop, not a loopback simulation.
test.describe('mobile bridge', () => {
  let launched: LaunchedApp
  let phone: FakePhone

  test.afterEach(async () => {
    phone?.close()
    await launched?.app.close()
  })

  test('phone pairs, lists, drives a session, approves a permission', async () => {
    launched = await launchApp()
    const { page } = launched

    const status = await page.evaluate(() => window.hang4r.bridgeSetEnabled(true))
    expect(status.enabled).toBe(true)

    const pairing = await page.evaluate(() => window.hang4r.bridgePairing())
    expect(pairing.url).toContain('hang4r://pair?')
    expect(pairing.qrDataUrl).toContain('data:image/png')

    await expect
      .poll(async () => (await page.evaluate(() => window.hang4r.bridgeStatus())).relayConnected, {
        timeout: 15_000
      })
      .toBe(true)

    phone = new FakePhone(pairing.url)
    await phone.connectWithRetry()

    await expect
      .poll(async () => (await page.evaluate(() => window.hang4r.bridgeStatus())).phoneConnected, {
        timeout: 15_000
      })
      .toBe(true)

    // request/response over the wire
    expect(await phone.call<Project[]>('listProjects')).toEqual([])
    const repo = makeScratchRepo()
    const project = await createProject(page, repo)
    const projects = await phone.call<Project[]>('listProjects')
    expect(projects.map((p) => p.id)).toContain(project.id)

    // phone starts a session and sees the transcript stream back
    const session = await phone.call<SessionMeta>('createSession', {
      projectId: project.id,
      backend: 'claude',
      environment: 'local',
      permissionMode: 'default',
      firstPrompt: 'hello from the phone'
    })
    phone.sub(session.id)
    const isEvent = (f: BridgeDesktopFrame): f is Extract<BridgeDesktopFrame, { t: 'event' }> =>
      f.t === 'event'
    await phone.nextEvent(
      (f) =>
        isEvent(f) &&
        f.channel === 'agent-event' &&
        (f.payload as SessionEvent).sessionId === session.id &&
        (f.payload as SessionEvent).event.kind === 'turn-complete'
    )
    const events = await phone.call<SessionEvent[]>('getSessionEvents', session.id)
    const kinds = events.map((e) => e.event.kind)
    expect(kinds).toContain('user-text')
    expect(kinds).toContain('turn-complete')

    // permission round-trip: fake adapter holds until respondPermission
    await phone.call('prompt', session.id, 'please ask permission before proceeding')
    const permEvent = await phone.nextEvent(
      (f) =>
        isEvent(f) &&
        f.channel === 'agent-event' &&
        (f.payload as SessionEvent).event.kind === 'permission-request'
    )
    const perm = (permEvent as Extract<BridgeDesktopFrame, { t: 'event' }>).payload as SessionEvent
    const req = perm.event as Extract<SessionEvent['event'], { kind: 'permission-request' }>
    await phone.call('respondPermission', session.id, req.requestId, 'allow')
    await phone.nextEvent(
      (f) =>
        isEvent(f) &&
        f.channel === 'agent-event' &&
        (f.payload as SessionEvent).event.kind === 'permission-resolved'
    )
    await phone.nextEvent(
      (f) =>
        isEvent(f) &&
        f.channel === 'agent-event' &&
        (f.payload as SessionEvent).event.kind === 'turn-complete'
    )

    // desktop mirrored the phone-driven conversation (same store, same events)
    const desktopEvents = await page.evaluate(
      (id) => window.hang4r.getSessionEvents(id),
      session.id
    )
    expect(desktopEvents.filter((e) => e.event.kind === 'permission-resolved').length).toBe(1)

    // allowlist holds: nothing outside BRIDGE_METHODS is callable
    await expect(phone.call('writeFile', session.id, 'x.txt', 'nope')).rejects.toThrow(
      /unknown method/
    )
  })

  test('the desktop bell reaches the phone: flagged, seen on open/focus/watch, marked read/unread', async () => {
    test.setTimeout(120_000)
    launched = await launchApp()
    const { page } = launched
    const project = await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')
    phone = await pairPhone(page)
    const unseenNow = async (): Promise<string[]> =>
      (await phone.call<BridgeSidebarState>('sidebarState')).unseen

    // finishes while nobody looks → the desktop flags it, the phone hears it
    const s = await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'bell one',
          firstPrompt: 'do the thing'
        }),
      project.id
    )
    await phone.nextEvent(frameFor('unseen', s.id))
    expect(await unseenNow()).toEqual([s.id])

    // opened on the desktop → seen everywhere, and gone from the snapshot
    const row = page.locator('.session-row', { hasText: 'bell one' })
    await row.click()
    await phone.nextEvent(frameFor('seen', s.id))
    await expect.poll(unseenNow).toEqual([])

    // "Mark as unread" / "Mark as read" on the desktop travel too
    await row.click({ button: 'right' })
    await page.locator('.ctx-menu .ctx-item', { hasText: 'Mark as unread' }).click()
    await phone.nextEvent(frameFor('unseen', s.id))
    await expect.poll(unseenNow).toEqual([s.id])
    phone.clearEvents()
    await row.click({ button: 'right' })
    await page.locator('.ctx-menu .ctx-item', { hasText: 'Mark as read' }).click()
    await phone.nextEvent(frameFor('seen', s.id))
    await expect.poll(unseenNow).toEqual([])

    // a turn that settles while you watch it was seen — the phone must not
    // keep the bell it would light from hearing the turn end
    phone.clearEvents()
    await page.evaluate((id) => window.hang4r.prompt(id, 'another turn'), s.id)
    await phone.nextEvent(
      (f) =>
        f.t === 'event' &&
        f.channel === 'agent-event' &&
        (f.payload as SessionEvent).sessionId === s.id &&
        (f.payload as SessionEvent).event.kind === 'turn-complete'
    )
    await test.step('watched turn → seen', () => phone.nextEvent(frameFor('seen', s.id)))
    expect(await unseenNow()).toEqual([])

    // focusing a session that is already open (the other split pane) is a look
    const t = await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'bell two'
        }),
      project.id
    )
    await page.locator('.session-row', { hasText: 'bell two' }).click({ modifiers: ['Meta'] })
    await expect(page.locator('.tile')).toHaveCount(2)
    phone.clearEvents()
    await page.locator('.tile').first().dispatchEvent('mousedown')
    await test.step('focus → seen', () => phone.nextEvent(frameFor('seen', s.id)))
    expect(t.id).toBeTruthy()
  })

  test('a flagged session is still flagged after the desktop restarts', async () => {
    test.setTimeout(90_000)
    launched = await launchApp()
    const { page, userDataDir } = launched
    const project = await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')
    const s = await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'survives',
          firstPrompt: 'do the thing'
        }),
      project.id
    )
    const row = page.locator('.session-row', { hasText: 'survives' })
    await expect(row.locator('.session-flag-finished')).toBeVisible({ timeout: 20_000 })
    await launched.app.close()

    launched = await launchApp({ userDataDir })
    const again = launched.page.locator('.session-row', { hasText: 'survives' })
    await expect(again.locator('.session-flag-finished')).toBeVisible({ timeout: 20_000 })
    phone = await pairPhone(launched.page)
    expect((await phone.call<BridgeSidebarState>('sidebarState')).unseen).toEqual([s.id])
  })

  test('a phone marks a session unread on the desktop, and every device hears it', async () => {
    test.setTimeout(90_000)
    launched = await launchApp()
    const { page } = launched
    const project = await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')
    phone = await pairPhone(page)
    const s = await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'mark me',
          firstPrompt: 'do the thing'
        }),
      project.id
    )
    const row = page.locator('.session-row', { hasText: 'mark me' })
    await expect(row.locator('.session-flag-finished')).toBeVisible({ timeout: 20_000 })
    await phone.call('markSeen', s.id)
    await expect(row.locator('.session-flag-finished')).toHaveCount(0)
    phone.clearEvents()

    await phone.call('markUnseen', s.id)
    await expect(row.locator('.session-flag-finished')).toBeVisible()
    await phone.nextEvent(frameFor('unseen', s.id))
    expect((await phone.call<BridgeSidebarState>('sidebarState')).unseen).toEqual([s.id])
  })

  test('work still running after a turn reaches the phone as it changes', async () => {
    test.setTimeout(90_000)
    launched = await launchApp()
    const { page } = launched
    const project = await createProject(page, makeScratchRepo())
    phone = await pairPhone(page)
    await phone.nextEvent((f) => f.t === 'live-work' && f.ids.length === 0)
    const s = await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          firstPrompt: 'spawn background agents'
        }),
      project.id
    )
    const frame = await phone.nextEvent((f) => f.t === 'live-work' && f.ids.length > 0)
    expect(frame).toEqual({ t: 'live-work', ids: [s.id] })
    expect((await phone.call<BridgeSidebarState>('sidebarState')).liveWork).toEqual([s.id])
  })
  test('a phone edits a sent message: every view restarts from it', async () => {
    test.setTimeout(120_000)
    launched = await launchApp()
    const { page } = launched
    const project = await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')
    phone = await pairPhone(page)
    const idle = async (id: string): Promise<void> => {
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.hang4r.listSessions())).find((x) => x.id === id)
              ?.status,
          { timeout: 20_000 }
        )
        .toBe('idle')
    }
    // codex: the fake agent can only truly truncate on the rollback path
    const s = await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'codex',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'rewind me',
          firstPrompt: 'first message alpha'
        }),
      project.id
    )
    await idle(s.id)
    await page.evaluate((id) => window.hang4r.prompt(id, 'second message beta'), s.id)
    await idle(s.id)
    await page.locator('.session-row', { hasText: 'rewind me' }).click()
    const cards = page.locator('.tile').first().locator('.msg-user-card')
    await expect(cards).toHaveCount(2)

    phone.sub(s.id)
    phone.clearEvents()
    await phone.call('rewindSession', s.id, 'first message alpha', 0, 'edited first gamma')
    await phone.nextEvent((f) => f.t === 'transcript-reset' && f.sessionId === s.id)
    await phone.nextEvent(
      (f) =>
        f.t === 'event' &&
        f.channel === 'agent-event' &&
        (f.payload as SessionEvent).event.kind === 'turn-complete'
    )
    const userTexts = (await phone.call<SessionEvent[]>('getSessionEvents', s.id))
      .map((e) => e.event)
      .filter((e) => e.kind === 'user-text')
      .map((e) => (e as { text: string }).text)
    expect(userTexts).toEqual(['edited first gamma'])

    // the desktop window had it open and was never told anything else
    await expect(cards).toHaveCount(1)
    await expect(cards).toContainText('edited first gamma')
  })
})
