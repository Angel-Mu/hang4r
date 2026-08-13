import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'
import { FakePhone } from './bridgeClient'
import type { SessionEvent, SessionMeta, Project } from '../src/shared/protocol'
import type { BridgeDesktopFrame } from '../src/shared/bridge'

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
})
