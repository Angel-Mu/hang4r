import { test, expect } from '@playwright/test'
import { parsePoisonAnchor } from '../src/main/services/claudeImport'

/**
 * Unit: parsePoisonAnchor finds the parentUuid to fork-truncate the POISONED turn
 * (the one carrying a dangling tool_use) out of a session's jsonl. Crucially it
 * targets the poison directly, so retry prompts ("continue") that pile up after
 * it can't drift the anchor past the poison (the bug that kept re-erroring with
 * error_during_execution — Angel).
 */
const line = (o: unknown): string => JSON.stringify(o)
const asst = (uuid: string, parentUuid: string | null, content: unknown[]): string =>
  line({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content } })
const user = (uuid: string, parentUuid: string | null, content: unknown[]): string =>
  line({ type: 'user', uuid, parentUuid, message: { role: 'user', content } })
const text = (t: string): unknown => ({ type: 'text', text: t })
const toolUse = (id: string): unknown => ({ type: 'tool_use', id, name: 'Bash', input: {} })
const toolResult = (id: string): unknown => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

test.describe('parsePoisonAnchor — fork-truncate the poisoned turn', () => {
  test('anchors at the message BEFORE the poisoned turn (drops the whole turn)', () => {
    const jsonl = [
      user('u0', null, [text('setup')]),
      asst('a0', 'u0', [text('ok')]),
      user('u1', 'a0', [text('do X')]), // ← poisoned turn root
      asst('a1', 'u1', [toolUse('t1')]) // dangling: no tool_result for t1
    ].join('\n')
    // resume-at a0 → keeps the clean prior turn, drops u1+a1 (the poison)
    expect(parsePoisonAnchor(jsonl)).toBe('a0')
  })

  test('a retry "continue" after the poison does NOT drift the anchor', () => {
    const jsonl = [
      user('u0', null, [text('setup')]),
      asst('a0', 'u0', [text('ok')]),
      user('u1', 'a0', [text('do X')]),
      asst('a1', 'u1', [toolUse('t1')]), // dangling
      user('u2', 'a1', [text('continue')]) // ← retry piled on after the poison
    ].join('\n')
    // still a0 — targets the poison turn, not the newer "continue"
    expect(parsePoisonAnchor(jsonl)).toBe('a0')
  })

  test('walks up past a mid-turn tool_result to the real turn root', () => {
    const jsonl = [
      user('u0', null, [text('setup')]),
      asst('a0', 'u0', [text('ok')]),
      user('u1', 'a0', [text('do X')]), // turn root
      asst('a1', 'u1', [toolUse('t1')]),
      user('r1', 'a1', [toolResult('t1')]), // tool-loop 'user' line (matched), NOT a root
      asst('a2', 'r1', [toolUse('t2')]) // dangling second tool
    ].join('\n')
    expect(parsePoisonAnchor(jsonl)).toBe('a0')
  })

  test('clean conversation (every tool_use matched) → null', () => {
    const jsonl = [
      user('u1', null, [text('go')]),
      asst('a1', 'u1', [toolUse('t1')]),
      user('r1', 'a1', [toolResult('t1')]),
      asst('a2', 'r1', [text('done')])
    ].join('\n')
    expect(parsePoisonAnchor(jsonl)).toBeNull()
  })

  test('poison in the very first turn (nothing before it) → null (caller falls back)', () => {
    const jsonl = [user('u1', null, [text('X')]), asst('a1', 'u1', [toolUse('t1')])].join('\n')
    expect(parsePoisonAnchor(jsonl)).toBeNull()
  })
})
