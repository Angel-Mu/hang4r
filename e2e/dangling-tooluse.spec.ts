import { test, expect } from '@playwright/test'
import { hasDanglingToolUse } from '../src/main/services/claudeImport'

/**
 * Unit: hasDanglingToolUse detects a conversation that ends mid-tool (an
 * assistant tool_use with no matching tool_result). Claude refuses to --resume
 * such a jsonl, so sessionManager fork-truncates past it. This is the poison a
 * turn aborted in an external interactive CLI leaves behind — the recurring
 * error_during_execution (Angel).
 */
const line = (o: unknown): string => JSON.stringify(o)
const asst = (uuid: string, parentUuid: string | null, content: unknown[]): string =>
  line({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content } })
const user = (uuid: string, parentUuid: string | null, content: unknown[]): string =>
  line({ type: 'user', uuid, parentUuid, message: { role: 'user', content } })

test.describe('hasDanglingToolUse — resume poison detection', () => {
  test('clean: every tool_use has a matching tool_result → not poisoned', () => {
    const jsonl = [
      user('u1', null, [{ type: 'text', text: 'go' }]),
      asst('a1', 'u1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]),
      user('u2', 'a1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]),
      asst('a2', 'u2', [{ type: 'text', text: 'done' }])
    ].join('\n')
    expect(hasDanglingToolUse(jsonl)).toBe(false)
  })

  test('aborted mid-tool: tool_use with no tool_result → poisoned', () => {
    const jsonl = [
      user('u1', null, [{ type: 'text', text: 'go' }]),
      asst('a1', 'u1', [{ type: 'tool_use', id: 'toolu_orphan', name: 'Task', input: {} }])
    ].join('\n')
    expect(hasDanglingToolUse(jsonl)).toBe(true)
  })

  test('one dangling tool_use among matched ones → poisoned', () => {
    const jsonl = [
      asst('a1', 'u1', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }
      ]),
      user('u2', 'a1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }])
      // toolu_2 never gets a result
    ].join('\n')
    expect(hasDanglingToolUse(jsonl)).toBe(true)
  })

  test('plain text (no tools) → not poisoned', () => {
    const jsonl = [
      user('u1', null, [{ type: 'text', text: 'hi' }]),
      asst('a1', 'u1', [{ type: 'text', text: 'hello' }])
    ].join('\n')
    expect(hasDanglingToolUse(jsonl)).toBe(false)
  })

  test('blank + malformed lines are ignored', () => {
    const jsonl = ['', '   ', 'not json', asst('a1', null, [{ type: 'text', text: 'ok' }])].join('\n')
    expect(hasDanglingToolUse(jsonl)).toBe(false)
  })
})
