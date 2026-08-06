import { test, expect } from '@playwright/test'
import { buildHandoffSeed, backendLabel } from '../src/main/services/handoff'
import type { AgentEvent } from '../src/shared/protocol'

/**
 * buildHandoffSeed reconstructs a readable transcript from a session's normalized
 * AgentEvent stream and wraps it as a seed prompt for a DIFFERENT backend to take
 * over (cross-agent handoff). Pure function → unit-tested directly.
 */
const userText = (text: string): AgentEvent => ({ kind: 'user-text', text })
const asstText = (text: string): AgentEvent => ({
  kind: 'block-final',
  messageId: 'm',
  blockIndex: 0,
  block: { type: 'text', text },
  parentToolUseId: null
})
const asstThinking = (thinking: string): AgentEvent => ({
  kind: 'block-final',
  messageId: 'm',
  blockIndex: 1,
  block: { type: 'thinking', thinking },
  parentToolUseId: null
})
const toolUse = (name: string, input: unknown): AgentEvent => ({
  kind: 'block-final',
  messageId: 'm',
  blockIndex: 2,
  block: { type: 'tool_use', id: 't', name, input },
  parentToolUseId: null
})
const toolResult = (content: unknown): AgentEvent => ({
  kind: 'tool-result',
  toolUseId: 't',
  content,
  isError: false,
  parentToolUseId: null
})

test.describe('buildHandoffSeed', () => {
  test('flattens the conversation and wraps it with a takeover preamble', () => {
    const seed = buildHandoffSeed(
      [
        userText('fix the failing test'),
        asstThinking('let me think about this in a way the new agent should NOT see'),
        asstText('On it — checking the suite.'),
        toolUse('Bash', { command: 'npm test' }),
        toolResult('1 failing: sum.test.ts')
      ],
      { sourceBackend: 'claude', maxChars: 48_000 }
    )
    // takeover preamble names the source agent
    expect(seed).toContain(backendLabel('claude')) // "Claude Code"
    expect(seed).toContain('taking over')
    // user + assistant turns are present and labeled
    expect(seed).toContain('User:')
    expect(seed).toContain('fix the failing test')
    expect(seed).toContain('Assistant:')
    expect(seed).toContain('On it — checking the suite.')
    // tool call + result are summarized as prose
    expect(seed).toContain('ran Bash: npm test')
    expect(seed).toContain('1 failing: sum.test.ts')
    // thinking is NOT carried (internal + large)
    expect(seed).not.toContain('the new agent should NOT see')
  })

  test('tail-slices a long history and marks it trimmed', () => {
    const events: AgentEvent[] = []
    events.push(userText('OLDEST_TURN_MARKER — this should be trimmed away'))
    for (let i = 0; i < 400; i++) events.push(asstText(`filler assistant line number ${i} `.repeat(6)))
    events.push(userText('NEWEST_TURN_MARKER — this must survive'))
    const seed = buildHandoffSeed(events, { sourceBackend: 'codex', maxChars: 4000 })
    expect(seed).toContain('NEWEST_TURN_MARKER') // tail kept
    expect(seed).not.toContain('OLDEST_TURN_MARKER') // head trimmed
    expect(seed).toContain('TAIL') // notes that earlier turns were trimmed
    expect(seed.length).toBeLessThan(4000 + 1200) // body ≤ budget + preamble/footer
  })

  test('external-turn user/assistant messages are included', () => {
    const seed = buildHandoffSeed(
      [{ kind: 'external-turn', role: 'user', text: 'continue on the phone', at: 1 }],
      { sourceBackend: 'claude', maxChars: 48_000 }
    )
    expect(seed).toContain('continue on the phone')
  })
})
