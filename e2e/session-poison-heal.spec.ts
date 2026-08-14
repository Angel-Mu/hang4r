import { test, expect } from '@playwright/test'
import { healPoisonedTranscript, hasDanglingToolUse } from '../src/main/services/claudeImport'

/**
 * Unit: healPoisonedTranscript repairs a POISONED transcript so `claude --resume`
 * accepts it again. A poisoned jsonl ends a turn with an assistant `tool_use` that
 * never got a matching `tool_result` (the tool was killed mid-flight — our own
 * SIGKILL on dispose/quit, or an OS OOM/crash). The heal appends the missing
 * tool_result line(s), KEEPING the aborted turn (unlike fork-truncating past it).
 *
 * The core assertion is the contract the CLI cares about: after healing,
 * hasDanglingToolUse is false — every tool_use has a matching tool_result.
 */
const line = (o: unknown): string => JSON.stringify(o)

interface Meta {
  cwd?: string
  sessionId?: string
  version?: string
  gitBranch?: string
  userType?: string
  entrypoint?: string
}
const META: Meta = {
  cwd: '/Users/dev/project',
  sessionId: 'sess-abc',
  version: '2.1.224',
  gitBranch: 'main',
  userType: 'external',
  entrypoint: 'sdk-cli'
}

const asst = (uuid: string, parentUuid: string | null, content: unknown[], meta: Meta = META): string =>
  line({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content }, ...meta })
const user = (uuid: string, parentUuid: string | null, content: unknown[], meta: Meta = META): string =>
  line({ type: 'user', uuid, parentUuid, message: { role: 'user', content }, ...meta })
const text = (t: string): unknown => ({ type: 'text', text: t })
const toolUse = (id: string): unknown => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 999' } })
const toolResult = (id: string): unknown => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

/** the jsonl lines the heal appended (everything past the original line count) */
const appendedLines = (raw: string, healed: string): Record<string, unknown>[] => {
  const before = raw.split('\n').filter((l) => l.trim()).length
  return healed
    .split('\n')
    .filter((l) => l.trim())
    .slice(before)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

test.describe('healPoisonedTranscript — repair a poisoned tail in place', () => {
  test('heals a dangling tool_use at the tail (hasDanglingToolUse → false)', () => {
    const raw = [
      user('u0', null, [text('setup')]),
      asst('a0', 'u0', [text('ok')]),
      user('u1', 'a0', [text('do X')]),
      asst('a1', 'u1', [toolUse('t1')]) // dangling: no tool_result for t1
    ].join('\n')
    expect(hasDanglingToolUse(raw)).toBe(true)

    const healed = healPoisonedTranscript(raw)
    expect(healed).not.toBeNull()
    expect(hasDanglingToolUse(healed as string)).toBe(false)

    const added = appendedLines(raw, healed as string)
    expect(added).toHaveLength(1)
    const h = added[0]
    expect(h.type).toBe('user')
    expect(h.parentUuid).toBe('a1') // parent = the line carrying the dangling tool_use
    expect(h.uuid).toBeTruthy()
    expect(h.uuid).not.toBe('a1')
    const content = (h.message as { content: Record<string, unknown>[] }).content
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true })
    expect(typeof content[0].content).toBe('string')
  })

  test('copies metadata (cwd/sessionId/version/gitBranch) from the carrying line', () => {
    const raw = [user('u1', null, [text('go')]), asst('a1', 'u1', [toolUse('t1')])].join('\n')
    const healed = healPoisonedTranscript(raw) as string
    const h = appendedLines(raw, healed)[0]
    expect(h).toMatchObject({
      cwd: META.cwd,
      sessionId: META.sessionId,
      version: META.version,
      gitBranch: META.gitBranch,
      userType: 'external',
      entrypoint: 'sdk-cli',
      sourceToolAssistantUUID: 'a1'
    })
  })

  test('a retry "continue" piled after the poison does NOT steal the parentUuid', () => {
    const raw = [
      user('u0', null, [text('setup')]),
      asst('a1', 'u0', [toolUse('t1')]), // dangling
      user('u2', 'a1', [text('continue')]) // retry piled on after the poison
    ].join('\n')
    const healed = healPoisonedTranscript(raw) as string
    expect(hasDanglingToolUse(healed)).toBe(false)
    const h = appendedLines(raw, healed)[0]
    // parent is the dangling tool_use line, NOT the newer "continue" — the pile-up
    // becomes an orphaned branch the CLI drops when it resumes the healed tip
    expect(h.parentUuid).toBe('a1')
  })

  test('heals multiple dangling tool_uses across different turns', () => {
    const raw = [
      user('u0', null, [text('a')]),
      asst('a1', 'u0', [toolUse('t1')]),
      user('r1', 'a1', [toolResult('t1')]), // matches t1
      asst('a2', 'r1', [toolUse('t2')]),
      user('r2', 'a2', [toolResult('t2')]), // matches t2
      asst('a3', 'r2', [toolUse('t3')]) // dangling: only t3 has no result
    ].join('\n')
    // t1 and t2 are matched; only t3 dangles here
    expect(hasDanglingToolUse(raw)).toBe(true)
    const healed = healPoisonedTranscript(raw) as string
    expect(hasDanglingToolUse(healed)).toBe(false)
    const added = appendedLines(raw, healed)
    expect(added).toHaveLength(1)
    expect(
      (added[0].message as { content: Record<string, unknown>[] }).content[0].tool_use_id
    ).toBe('t3')
  })

  test('two genuinely dangling tool_uses both get a result', () => {
    const raw = [
      user('u0', null, [text('a')]),
      asst('a1', 'u0', [toolUse('t1')]), // dangling
      user('u1', 'a1', [text('b')]),
      asst('a2', 'u1', [toolUse('t2')]) // dangling
    ].join('\n')
    const healed = healPoisonedTranscript(raw) as string
    expect(hasDanglingToolUse(healed)).toBe(false)
    const added = appendedLines(raw, healed)
    expect(added).toHaveLength(2)
    const ids = added.map(
      (h) => (h.message as { content: Record<string, unknown>[] }).content[0].tool_use_id
    )
    expect(new Set(ids)).toEqual(new Set(['t1', 't2']))
  })

  test('a clean transcript is left untouched (returns null)', () => {
    const raw = [
      user('u0', null, [text('setup')]),
      asst('a1', 'u0', [toolUse('t1')]),
      user('r1', 'a1', [toolResult('t1')]),
      asst('a2', 'r1', [text('done')])
    ].join('\n')
    expect(hasDanglingToolUse(raw)).toBe(false)
    expect(healPoisonedTranscript(raw)).toBeNull()
  })

  test('preserves the original bytes exactly (only appends)', () => {
    const raw = [user('u0', null, [text('go')]), asst('a1', 'u0', [toolUse('t1')])].join('\n')
    const healed = healPoisonedTranscript(raw) as string
    expect(healed.startsWith(raw)).toBe(true)
    expect(healed.endsWith('\n')).toBe(true)
  })
})
