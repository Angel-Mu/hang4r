import { test, expect } from '@playwright/test'
import { parseMessagesAfter, filterExternalTurns } from '../src/main/services/claudeImport'

/**
 * Regression for Angel's phantom "⇄ interactive CLI" fork. When a tool call is
 * INTERRUPTED, the Claude CLI writes hang4r's own just-ended turn to the jsonl.
 * The external-CLI re-sync must NOT re-import those lines as an "interactive CLI"
 * turn — that made a single-session, single-process interrupt look like a second
 * agent forking the conversation. The guard is filterExternalTurns(msgs,
 * turnEndedAt): our own turn's lines carry a timestamp <= turnEndedAt (recorded
 * synchronously at turn-complete), so they drop; a genuinely external turn comes
 * AFTER turnEndedAt and survives. Forensics on the real session (utilityprofit
 * PR #2423) confirmed: one process, one lineage, one CLI version — no fork.
 */
const asst = (uuid: string, parentUuid: string, text: string, ts: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
const user = (uuid: string, parentUuid: string, content: unknown[], ts: string): string =>
  JSON.stringify({ type: 'user', uuid, parentUuid, timestamp: ts, message: { role: 'user', content } })

test.describe('external-turn re-sync — never re-import our OWN interrupted turn', () => {
  test('our own turn after the watermark is NOT external (the phantom fork)', () => {
    // watermark = the tool_result line before "Approved…". Then the CLI flushes
    // our own turn (the text + the interrupt marker) — all part of the turn that
    // was interrupted. turn-complete fires AFTER, so turnEndedAt is later.
    const jsonl = [
      user('wm', 'p0', [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }], '2026-08-04T20:37:30.919Z'),
      asst('own1', 'wm', 'Approved. Verifying before merging.', '2026-08-04T20:37:35.333Z'),
      user(
        'int',
        'own1',
        [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
        '2026-08-04T20:37:38.091Z'
      )
    ].join('\n')
    const turnEndedAt = Date.parse('2026-08-04T20:37:39.000Z') // turn-complete fires after the interrupt
    const external = filterExternalTurns(parseMessagesAfter(jsonl, 'wm'), turnEndedAt)
    expect(external).toEqual([]) // our own interrupted turn is NOT an "interactive CLI" turn
  })

  test('a genuinely external turn (after turn end) IS detected', () => {
    const jsonl = [
      user('wm', 'p0', [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }], '2026-08-04T20:37:30.919Z'),
      user('ext-u', 'wm', [{ type: 'text', text: 'now do the next thing' }], '2026-08-04T20:41:00.000Z'),
      asst('ext-a', 'ext-u', 'on it', '2026-08-04T20:41:02.000Z')
    ].join('\n')
    const turnEndedAt = Date.parse('2026-08-04T20:37:39.000Z')
    const external = filterExternalTurns(parseMessagesAfter(jsonl, 'wm'), turnEndedAt)
    expect(external.map((m) => `${m.role}:${m.text}`)).toEqual(['user:now do the next thing', 'assistant:on it'])
  })

  test('parseMessagesAfter starts strictly after the uuid and drops tool_results / meta', () => {
    const jsonl = [
      asst('before', 'p', 'BEFORE the watermark — must be ignored', '2026-08-04T20:00:00.000Z'),
      asst('wm', 'before', 'watermark line', '2026-08-04T20:00:01.000Z'),
      user('u1', 'wm', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], '2026-08-04T20:00:02.000Z'),
      user('u2', 'u1', [{ type: 'text', text: '<command-name>/foo</command-name>' }], '2026-08-04T20:00:03.000Z'),
      asst('a1', 'u2', 'the real reply', '2026-08-04T20:00:04.000Z')
    ].join('\n')
    expect(parseMessagesAfter(jsonl, 'wm').map((m) => m.text)).toEqual(['the real reply'])
  })

  test('no turnEndedAt → uuid-position filtering only (passthrough)', () => {
    expect(filterExternalTurns([{ role: 'user', text: 'x', at: 0 }], undefined)).toHaveLength(1)
  })
})
