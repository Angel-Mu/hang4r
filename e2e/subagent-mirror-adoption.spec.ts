import { test, expect } from '@playwright/test'
import { parseMessagesAfter, filterExternalTurns } from '../src/main/services/claudeImport'

/**
 * PHASE-1 REPRO (root cause) for the recurring "The CLI errored" that hit
 * "always when a subagent is running" (Angel; screenshot: the same turn's text
 * appears twice — once normal, once tagged "⇄ interactive CLI" — then
 * error_during_execution, then a forced "continue").
 *
 * The passive external-turn MIRROR (SessionManager.resyncExternal, polled every
 * ~2.5s) re-read the CLI's own jsonl and imported "lines after our watermark" as
 * EXTERNAL "⇄ interactive CLI" turns (the /remote-control mirror). Its building
 * blocks are UNSAFE around subagents, for TWO independent reasons proven below:
 *
 *   1. parseMessagesAfter does NOT exclude subagent SIDECHAIN lines
 *      (isSidechain:true) — a subagent's internal user/assistant messages are
 *      type user/assistant, so they sail straight through.
 *   2. filterExternalTurns lets through any line with NO timestamp (`!m.at`) —
 *      and a subagent's final synthesis line is flushed LATE, so the uuid
 *      watermark lands one line short and that late line (timestamp not yet
 *      written) is re-imported as "external".
 *
 * Result: hang4r's OWN just-finished subagent turn is mis-adopted as an
 * interactive-CLI turn → the duplicate, the drift, the next --resume error.
 *
 * This spec proves the mis-adoption at the exact call sequence resyncExternal
 * used: filterExternalTurns(parseMessagesAfter(jsonl, watermarkUuid), turnEndedAt).
 * It is WHY the mirror was retired — the fix (resyncExternal never adopts) is
 * verified end-to-end in subagent-resync-no-adopt.spec.ts.
 */

const line = (o: unknown): string => JSON.stringify(o)
const asst = (
  uuid: string,
  parentUuid: string,
  content: unknown[],
  opts: { ts?: string; sidechain?: boolean } = {}
): string =>
  line({
    type: 'assistant',
    uuid,
    parentUuid,
    ...(opts.ts ? { timestamp: opts.ts } : {}),
    ...(opts.sidechain ? { isSidechain: true } : {}),
    message: { role: 'assistant', content }
  })
const user = (
  uuid: string,
  parentUuid: string,
  content: unknown[],
  opts: { ts?: string; sidechain?: boolean } = {}
): string =>
  line({
    type: 'user',
    uuid,
    parentUuid,
    ...(opts.ts ? { timestamp: opts.ts } : {}),
    ...(opts.sidechain ? { isSidechain: true } : {}),
    message: { role: 'user', content }
  })
const text = (t: string): unknown => ({ type: 'text', text: t })
const toolUse = (id: string): unknown => ({ type: 'tool_use', id, name: 'Agent', input: {} })
const toolResult = (id: string): unknown => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

test.describe('subagent transcript — the mirror mis-adopts hang4r\'s OWN turn', () => {
  // ONE hang4r turn that runs a subagent: main prompt + Task tool_use, the
  // subagent's isSidechain user/assistant lines, the Task result, and the final
  // main assistant synthesis flushed LATE (no timestamp yet).
  const T = (s: string): string => `2026-08-19T10:00:${s}.000Z`
  const jsonl = [
    user('u1', 'aPrev', [text('Refactor foo using a subagent')], { ts: T('00') }), // hang4r's own prompt
    asst('a1', 'u1', [toolUse('task1')], { ts: T('01') }), // main: launch the Agent/Task
    user('s1', 'a1', [text('Investigate foo.ts')], { ts: T('02'), sidechain: true }), // subagent internal
    asst('s2', 's1', [text('Found the bug at foo.ts:42')], { ts: T('03'), sidechain: true }), // subagent internal
    user('r1', 'a1', [toolResult('task1')], { ts: T('10') }), // main: Task result  ← watermark lands here (one short)
    asst('a2', 'r1', [text('The subagent found the bug at foo.ts:42. Fixed it.')]) // final main, NO timestamp (late flush)
  ].join('\n')

  test('FAILURE MODE 2: the late-flushed final line (no timestamp) is mis-adopted as external', () => {
    // recordSyncWatermark reads tailUuid at turn-complete, BEFORE the CLI flushed
    // the final assistant line — so the watermark points at r1 (one line short).
    // turnEndedAt is the CURRENT turn's end (recorded synchronously), which SHOULD
    // protect us — but a2 has no timestamp, so the timestamp guard is defeated.
    const watermarkUuid = 'r1'
    const turnEndedAt = Date.parse(T('10')) + 500 // just after the turn ended

    const adopted = filterExternalTurns(parseMessagesAfter(jsonl, watermarkUuid), turnEndedAt)

    // MIS-ADOPTION: hang4r's OWN final synthesis line comes back as an "external"
    // turn — this is the duplicate the screenshot shows (once normal, once tagged
    // "⇄ interactive CLI"), and the resume drift that then errors.
    expect(adopted.map((m) => `${m.role}:${m.text}`)).toEqual([
      'assistant:The subagent found the bug at foo.ts:42. Fixed it.'
    ])
  })

  test('FAILURE MODE 1: parseMessagesAfter never excludes subagent SIDECHAIN lines', () => {
    // watermark one line short of the subagent — everything after a1 is scanned.
    // The subagent's internal user+assistant lines (isSidechain:true) are NOT
    // dropped: they are structurally indistinguishable to parseMessagesAfter.
    const parsed = parseMessagesAfter(jsonl, 'a1')
    expect(parsed.map((m) => m.text)).toContain('Investigate foo.ts') // sidechain user
    expect(parsed.map((m) => m.text)).toContain('Found the bug at foo.ts:42') // sidechain assistant
  })

  test('the two holes COMBINE: a late-flushed sidechain line (no ts) survives the filter', () => {
    // A subagent line flushed late enough to lack a timestamp defeats BOTH guards
    // at once: sidechain isn't excluded (mode 1) AND no-timestamp passes (mode 2),
    // even with a current turnEndedAt — so the subagent's own words get mirrored
    // back as an interactive-CLI turn.
    const lateSidechain = [
      user('u1', 'aPrev', [text('Refactor foo using a subagent')], { ts: T('00') }),
      asst('a1', 'u1', [toolUse('task1')], { ts: T('01') }),
      asst('s2', 'a1', [text('Subagent: found the bug at foo.ts:42')], { sidechain: true }) // late, NO ts
    ].join('\n')
    const turnEndedAt = Date.parse(T('05'))
    const adopted = filterExternalTurns(parseMessagesAfter(lateSidechain, 'a1'), turnEndedAt)
    expect(adopted.map((m) => m.text)).toContain('Subagent: found the bug at foo.ts:42')
  })
})
