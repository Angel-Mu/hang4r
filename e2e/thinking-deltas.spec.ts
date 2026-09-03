import { test, expect } from '@playwright/test'
import { translateClaudeEvent } from '../src/main/services/adapters/claudeAdapter'

/**
 * Angel, twice: "we are still not able to see the thought process".
 *
 * The renderer was fine and the fake agent proved it — by emitting a thinking
 * block WITH its text, which the real CLI never does. Its authoritative
 * assistant snapshot repeats a thinking block as {"type":"thinking","thinking":""}
 * and sends the words only as content_block_delta. Deltas are broadcast-only, so
 * what got persisted was an empty block and ThinkingBlock rendered nothing.
 *
 * This drives the translation layer directly, with the shape the CLI actually
 * sends — the layer the fake agent cannot reach.
 */
function makeState(): Parameters<typeof translateClaudeEvent>[1] {
  const finals = new Map<string, number>()
  const deltas = new Map<string, string>()
  const tokens = new Map<string, number>()
  let messageId: string | null = null
  let parent: string | null = null
  let ctx = 0
  return {
    _getMessageId: () => messageId,
    _setMessageId: (id) => {
      messageId = id
    },
    _getParent: () => parent,
    _setParent: (p) => {
      parent = p
    },
    _nextFinalIndex: (id) => {
      const n = finals.get(id) ?? 0
      finals.set(id, n + 1)
      return n
    },
    _appendDelta: (k, t) => deltas.set(k, (deltas.get(k) ?? '') + t),
    _takeDelta: (k) => {
      const t = deltas.get(k) ?? ''
      deltas.delete(k)
      return t
    },
    _noteThinkingTokens: (k, n) => tokens.set(k, Math.max(tokens.get(k) ?? 0, n)),
    _takeThinkingTokens: (k) => {
      const n = tokens.get(k) ?? 0
      tokens.delete(k)
      return n
    },
    _getContextTokens: () => ctx,
    _setContextTokens: (n) => {
      ctx = n
    }
  }
}

test('reasoning streamed as deltas survives into the persisted block', () => {
  const state = makeState()
  const mid = 'msg_1'
  state._setMessageId(mid) // normally set by the CLI's message_start event

  translateClaudeEvent(
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      message: { id: mid }
    },
    state
  )
  for (const part of ['Reading the request. ', 'A direct edit beats a refactor.']) {
    translateClaudeEvent(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { thinking: part } },
        message: { id: mid }
      },
      state
    )
  }

  // the snapshot the CLI actually sends: the block, with its text stripped out
  const out = translateClaudeEvent(
    { type: 'assistant', message: { id: mid, content: [{ type: 'thinking', thinking: '' }] } },
    state
  )

  const final = out.find((e) => e.kind === 'block-final')
  expect(final).toBeTruthy()
  const block = (final as { block: { type: string; thinking?: string } }).block
  expect(block.type).toBe('thinking')
  expect(block.thinking).toBe('Reading the request. A direct edit beats a refactor.')
})

/**
 * Captured from a real `claude -p` run that actually reasoned: the assistant
 * snapshot repeats the block as {"thinking":""} AND every thinking_delta carries
 * {"thinking":"","estimated_tokens":N}. The words are withheld on both sides;
 * the count is the only thing the CLI parts with, so a redacted block can still
 * report that it happened.
 */
test('a redacted reasoning block keeps its token estimate', () => {
  const state = makeState()
  const mid = 'msg_real'
  state._setMessageId(mid)

  translateClaudeEvent(
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }
    },
    state
  )
  for (const n of [50, 180, 640]) {
    translateClaudeEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '', estimated_tokens: n }
        }
      },
      state
    )
  }

  const out = translateClaudeEvent(
    { type: 'assistant', message: { id: mid, content: [{ type: 'thinking', thinking: '' }] } },
    state
  )
  const block = (out.find((e) => e.kind === 'block-final') as {
    block: { type: string; thinking?: string; tokens?: number }
  }).block
  expect(block.type).toBe('thinking')
  expect(block.thinking).toBe('')
  expect(block.tokens).toBe(640) // the running estimate, not the sum
})
