import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * FIX VERIFICATION for the recurring "The CLI errored" that hit "always when a
 * subagent is running" (Angel). The passive external-turn mirror
 * (SessionManager.resyncExternal, polled every ~2.5s via sessions:resync) used to
 * re-import "lines after our watermark" as "⇄ interactive CLI" turns. Around a
 * subagent it mis-adopted hang4r's OWN turn (sidechain lines aren't excluded; a
 * late-flushed line has no timestamp so it passes the filter; the watermark lands
 * one line short) → the duplicate turn + drift that then errored the next
 * --resume. Root cause proven at the unit level in subagent-mirror-adoption.spec.ts.
 *
 * The mirror is retired: resyncExternal now NEVER auto-adopts an external turn.
 * This test drives the REAL resyncExternal via the bridge against a crafted
 * subagent transcript + a one-line-short watermark, and asserts NOTHING is
 * adopted. Before the fix this exact setup adopted the final synthesis line as an
 * external-turn; after the fix resync returns 0 and no external-turn is created.
 */

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('resyncExternal never adopts a subagent turn as an external "⇄ interactive CLI" turn', async () => {
  // a crafted claude-history root so ClaudeImport.sessionFile resolves our
  // subagent transcript without touching the real ~/.claude
  const claudeRoot = mkdtempSync(join(tmpdir(), 'hang4r-claude-'))
  launched = await launchApp({ env: { HANG4R_CLAUDE_PROJECTS_DIR: claudeRoot } })
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)

  // an IDLE claude session (no first prompt): it gets a backendSessionId from the
  // fake adapter's init, and NO turn-complete fires — so nothing overwrites the
  // watermark we seed below (recordSyncWatermark only runs at turn-complete).
  const session = await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'subagent-resync'
      }),
    { pid: project.id }
  )
  const backendSessionId = session.backendSessionId
  expect(backendSessionId).toBeTruthy()

  // ONE hang4r turn that runs a subagent: main prompt + Agent tool_use, the
  // subagent's isSidechain user/assistant lines, the Task result, and the final
  // main synthesis flushed LATE (NO timestamp).
  const T = (s: string): string => `2026-08-19T10:00:${s}.000Z`
  const L = (o: unknown): string => JSON.stringify(o)
  const jsonl =
    [
      L({
        type: 'user',
        uuid: 'u1',
        parentUuid: 'aPrev',
        timestamp: T('00'),
        message: { role: 'user', content: [{ type: 'text', text: 'Refactor foo using a subagent' }] }
      }),
      L({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: T('01'),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'task1', name: 'Agent', input: {} }] }
      }),
      L({
        type: 'user',
        uuid: 's1',
        parentUuid: 'a1',
        isSidechain: true,
        timestamp: T('02'),
        message: { role: 'user', content: [{ type: 'text', text: 'Investigate foo.ts' }] }
      }),
      L({
        type: 'assistant',
        uuid: 's2',
        parentUuid: 's1',
        isSidechain: true,
        timestamp: T('03'),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found the bug at foo.ts:42' }] }
      }),
      L({
        type: 'user',
        uuid: 'r1',
        parentUuid: 'a1',
        timestamp: T('10'),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task1', content: 'ok' }] }
      }),
      L({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'r1',
        // NO timestamp — the late-flushed final synthesis (defeats the time guard)
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The subagent found the bug at foo.ts:42. Fixed it.' }]
        }
      })
    ].join('\n') + '\n'
  const dir = join(claudeRoot, 'e2e-subagent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${backendSessionId}.jsonl`), jsonl)

  // seed the watermark ONE LINE SHORT (at the tool_result r1, before the
  // late-flushed final line) — exactly what recordSyncWatermark records when the
  // CLI hasn't flushed the final assistant line yet. turnEndedAt is current.
  await page.evaluate(
    ({ id, fileId }) =>
      window.hang4r.setSetting(
        `syncWatermark:${id}`,
        JSON.stringify({ uuid: 'r1', fileId, turnEndedAt: Date.parse('2026-08-19T10:00:10.500Z') })
      ),
    { id: session.id, fileId: backendSessionId }
  )

  // drive the REAL resync poll (sessions:resync → resyncAndRecover → resyncExternal)
  const imported = await page.evaluate((id) => window.hang4r.resyncSession(id), session.id)
  expect(imported).toBe(0) // adopts nothing

  // and no external-turn event was ever created in the transcript
  const events = await page.evaluate((id) => window.hang4r.getSessionEvents(id), session.id)
  const externalTurns = events.filter((e) => e.event.kind === 'external-turn')
  expect(externalTurns).toHaveLength(0)
})
