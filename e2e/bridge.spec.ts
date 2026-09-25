import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'
import { FakePhone } from './bridgeClient'
import type { SessionEvent, SessionMeta, Project } from '../src/shared/protocol'
import type { BridgeDesktopFrame, BridgeEventPage, BridgeSidebarState } from '../src/shared/bridge'
import type { LinkDiagnostics } from '../src/shared/bridgeLink'
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

const SHOTS = '/private/tmp/claude-501/mobile-round-18-shots'

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
  test('a phone edit keeps the earlier turns the desktop loaded', async () => {
    test.setTimeout(120_000)
    launched = await launchApp()
    const { page } = launched
    const project = await createProject(page, makeScratchRepo())
    await page.evaluate(() => window.hang4r.setSetting('openTurns', '1'))
    phone = await pairPhone(page)
    const s = await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'codex',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'windowed',
          firstPrompt: 'turn 1'
        }),
      project.id
    )
    const idle = async (): Promise<void> => {
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.hang4r.listSessions())).find((x) => x.id === s.id)
              ?.status,
          { timeout: 20_000 }
        )
        .toBe('idle')
    }
    await idle()
    for (const n of [2, 3]) {
      await page.evaluate(([id, t]) => window.hang4r.prompt(id as string, `turn ${t}`), [s.id, n])
      await idle()
    }
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.session-row', { hasText: 'windowed' }).click()
    const tile = page.locator('.tile').first()
    const earlier = tile.locator('.chat-load-earlier')
    await earlier.click({ timeout: 20_000 })
    const cards = tile.locator('.msg-user-card')
    await expect(cards).toHaveCount(3)

    await phone.call('rewindSession', s.id, 'turn 3', 0, 'turn 3 edited')
    await idle()
    // the card also holds its edit button's glyph
    const want = ['turn 1', 'turn 2', 'turn 3 edited'].map((t) => new RegExp(`${t}$`))
    await expect(cards).toHaveText(want)
    await expect(earlier).toHaveCount(0)
  })


  test('a phone is sent only what it shows: no subagent streams, no hooks, tool output trimmed', async () => {
    test.setTimeout(120_000)
    launched = await launchApp()
    const { page } = launched
    const project = await createProject(page, makeScratchRepo())
    phone = await pairPhone(page)
    const s = await phone.call<SessionMeta>('createSession', {
      projectId: project.id,
      backend: 'claude',
      environment: 'local',
      permissionMode: 'acceptEdits',
      firstPrompt: 'print a long log'
    })
    phone.sub(s.id)
    const live: SessionEvent[] = []
    await phone.nextEvent((f) => {
      if (f.t !== 'event' || f.channel !== 'agent-event') return false
      const ev = f.payload as SessionEvent
      if (ev.sessionId !== s.id) return false
      live.push(ev)
      return ev.event.kind === 'turn-complete'
    }, 30_000)

    const ignored = ['rate-limit', 'hook', 'subagent-note', 'stderr']
    const resultLengths = (evs: SessionEvent[]): number[] =>
      evs
        .map((e) => e.event)
        .filter((e) => e.kind === 'tool-result')
        .map((e) => {
          const c = (e as { content: unknown }).content
          return (typeof c === 'string' ? c : JSON.stringify(c)).length
        })
    const history = await phone.call<SessionEvent[]>('getSessionEvents', s.id)
    for (const evs of [live, history]) {
      expect(evs.map((e) => e.event.kind)).toContain('user-text')
      expect(evs.filter((e) => ignored.includes(e.event.kind))).toEqual([])
      expect(evs.filter((e) => 'parentToolUseId' in e.event && e.event.parentToolUseId)).toEqual([])
      expect(Math.max(...resultLengths(evs))).toBe(2000)
    }
    // trimmed for the phone only: the desktop keeps the whole record
    const full = await page.evaluate((id) => window.hang4r.getSessionEvents(id), s.id)
    expect(full.some((e) => e.event.kind === 'rate-limit')).toBe(true)
    expect(full.some((e) => 'parentToolUseId' in e.event && e.event.parentToolUseId)).toBe(true)
    expect(Math.max(...resultLengths(full))).toBeGreaterThan(2000)
  })

  test('history reaches a phone in pages of whole turns, oldest last', async () => {
    test.setTimeout(180_000)
    launched = await launchApp({ env: { HANG4R_TEST_BRIDGE_PAGE_BYTES: '6000' } })
    const { page } = launched
    const project = await createProject(page, makeScratchRepo())
    const prompts = Array.from({ length: 8 }, (_, i) => `turn ${i + 1}`)
    const s = await page.evaluate(
      ({ pid, first }) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'long history',
          firstPrompt: first
        }),
      { pid: project.id, first: prompts[0] }
    )
    const idle = async (): Promise<void> => {
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.hang4r.listSessions())).find((x) => x.id === s.id)
              ?.status,
          { timeout: 20_000 }
        )
        .toBe('idle')
    }
    await idle()
    for (const text of prompts.slice(1)) {
      await page.evaluate(([id, t]) => window.hang4r.prompt(id, t), [s.id, text])
      await idle()
    }
    phone = await pairPhone(page)

    const pages: BridgeEventPage[] = []
    let before: number | undefined
    do {
      pages.push(
        await phone.call<BridgeEventPage>('getSessionEventsPage', s.id, before ? { before } : {})
      )
      before = pages.at(-1)!.cursor ?? undefined
    } while (before !== undefined && pages.length < 50)
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.at(-1)!.cursor).toBeNull()

    const carried = ['init', 'plan']
    for (const p of pages) {
      // every page starts on a turn's first event — nothing cut mid-turn
      const body = p.events.filter((e) => !carried.includes(e.event.kind))
      expect(body[0].event.kind).toBe('user-text')
      const seqs = p.events.map((e) => e.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    }
    // the newest page still knows the model, though init is far older
    expect(pages[0].events.find((e) => e.event.kind === 'init')?.event).toMatchObject({
      model: 'fake-model'
    })

    const bySeq = new Map<number, SessionEvent>()
    for (const p of pages) for (const e of p.events) bySeq.set(e.seq, e)
    const paged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    const whole = await phone.call<SessionEvent[]>('getSessionEvents', s.id)
    const texts = (evs: SessionEvent[]): string[] =>
      evs.filter((e) => e.event.kind === 'user-text').map((e) => (e.event as { text: string }).text)
    expect(texts(paged)).toEqual(prompts)
    // pages add up to the whole history, apart from superseded plan/usage
    const kinds = (evs: SessionEvent[]): string[] =>
      evs.filter((e) => !['plan', 'usage'].includes(e.event.kind)).map((e) => `${e.seq}`)
    expect(kinds(paged)).toEqual(kinds(whole))
  })

  const diag = (page: Page): Promise<LinkDiagnostics> =>
    page.evaluate(() => window.hang4r.bridgeDiagnostics())

  test('a relay link that goes silent is replaced, with no phone around to notice', async () => {
    test.setTimeout(90_000)
    // the first socket hears nothing: a link that died without a close
    launched = await launchApp({
      env: { HANG4R_TEST_BRIDGE_DEAF: '1', HANG4R_TEST_BRIDGE_TIMING: 'ping=1000,silence=5000' }
    })
    const { page } = launched
    await page.evaluate(() => window.hang4r.bridgeSetEnabled(true))
    await expect.poll(async () => (await diag(page)).reconnects, { timeout: 30_000 }).toBeGreaterThan(0)
    const d = await diag(page)
    expect(d.lastClose?.reason).toBe('no frames for 5s')
    expect(d.log.map((e) => e.msg)).toContain('dropped the relay socket: no frames for 5s')
    // the replacement socket is healthy: a phone gets through
    phone = await pairPhone(page)
    expect(await phone.call('listProjects')).toEqual([])
  })

  test('an idle desktop with no phone stays up on the relay\'s pongs alone', async () => {
    test.setTimeout(60_000)
    launched = await launchApp({ env: { HANG4R_TEST_BRIDGE_TIMING: 'ping=1000,silence=5000' } })
    const { page } = launched
    await page.evaluate(() => window.hang4r.bridgeSetEnabled(true))
    await expect.poll(async () => (await diag(page)).state, { timeout: 15_000 }).toBe('open')
    // three silence windows with nobody on the other end
    await page.waitForTimeout(15_000)
    const d = await diag(page)
    expect(d.reconnects).toBe(0)
    expect(d.state).toBe('open')
    expect(Date.now() - (d.lastRxAt ?? 0)).toBeLessThan(3_000)
  })

  test('Reconnect replaces the socket and keeps the pairing; Re-pair says phones must rescan', async () => {
    test.setTimeout(90_000)
    launched = await launchApp()
    const { page } = launched
    await page.waitForSelector('.app')
    phone = await pairPhone(page)
    const before = await page.evaluate(() => window.hang4r.bridgePairing())
    await expect.poll(async () => (await diag(page)).peerVersion).toBe('e2e')

    await page.keyboard.press('Meta+k')
    await page.locator('.palette-input').fill('settings')
    await page.locator('.palette-input').press('Enter')
    await page.locator('.settings-nav-item', { hasText: 'Phone' }).click()
    await page.getByRole('button', { name: 'Reconnect' }).click()

    await expect.poll(async () => (await diag(page)).reconnects, { timeout: 15_000 }).toBe(1)
    expect((await diag(page)).lastClose?.reason).toBe('Reconnect clicked')
    await expect
      .poll(async () => (await page.evaluate(() => window.hang4r.bridgeStatus())).phoneConnected, {
        timeout: 15_000
      })
      .toBe(true)
    // same secret: the phone already paired keeps working without a rescan
    expect((await page.evaluate(() => window.hang4r.bridgePairing())).url).toBe(before.url)
    expect(await phone.call('listProjects')).toEqual([])

    const panel = page.locator('.bridge-diag')
    await expect(panel.locator('[data-diag="reconnects"]')).toHaveText('1')
    await expect(panel.locator('[data-diag="close"]')).toContainText('Reconnect clicked')
    await page.getByRole('button', { name: 'Show pairing QR code' }).click()
    await expect(page.locator('.settings-page')).toContainText(
      'every phone paired now is cut off and must scan the new QR code'
    )
    await page.locator('.bridge-diag').scrollIntoViewIfNeeded()
    await page.locator('.settings-page').screenshot({ path: `${SHOTS}/10-desktop-connection.png` })

    const copied = await page.evaluate(async () => {
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
    expect(copied).toContain('hang4r bridge — desktop')
    expect(copied).toContain('reconnects: 1')
    expect(copied).toContain('Reconnect clicked')
  })
})
