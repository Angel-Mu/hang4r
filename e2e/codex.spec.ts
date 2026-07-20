// Codex integration unit specs (parsing + model discovery) — consolidated:
// the suite stays one-file-per-domain (session-flow / real-claude / visual / codex).
import { expect, test } from '@playwright/test'
import { codexSummaryFromJsonl, codexTranscriptFromJsonl } from '../src/main/services/codexImport'

const sample = [
  JSON.stringify({
    timestamp: '2026-07-08T20:20:47.679Z',
    type: 'session_meta',
    payload: {
      session_id: '019f4362-4d1e-7c51-8a99-64d354f0ba1d',
      timestamp: '2026-07-08T20:19:03.595Z',
      cwd: '/Users/angel_xmu/Documents/claude-agentic-ide'
    }
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>noise</environment_context>' }]
    }
  }),
  JSON.stringify({
    timestamp: '2026-07-08T20:20:50.000Z',
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: 'Fix Codex sessions in hang4r'
    }
  }),
  JSON.stringify({
    timestamp: '2026-07-08T20:20:58.619Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: 'I found the hard-coded Codex model choices.'
    }
  })
].join('\n')

test.describe('Codex import parsing', () => {
  test('summarizes Codex JSONL sessions using user-visible event messages', () => {
    const summary = codexSummaryFromJsonl(sample, { id: 'fallback', mtime: 123 })

    expect(summary).toMatchObject({
      id: '019f4362-4d1e-7c51-8a99-64d354f0ba1d',
      name: 'Fix Codex sessions in hang4r',
      cwd: '/Users/angel_xmu/Documents/claude-agentic-ide',
      messageCount: 2,
      lastMessage: 'I found the hard-coded Codex model choices.'
    })
    expect(summary?.createdAt).toBe(Date.parse('2026-07-08T20:19:03.595Z'))
  })

  test('extracts a visible transcript without system/environment response items', () => {
    expect(codexTranscriptFromJsonl(sample)).toEqual([
      { role: 'user', text: 'Fix Codex sessions in hang4r' },
      { role: 'assistant', text: 'I found the hard-coded Codex model choices.' }
    ])
  })
})

import { codexModelChoicesFromPages } from '../src/main/services/codexModelService'
import { contextWindow } from '../src/renderer/src/contextWindow'

test.describe('Codex model discovery', () => {
  test('normalizes the account model list without stale hardcoded models', () => {
    const models = codexModelChoicesFromPages(
      [
        {
          data: [
            {
              model: 'gpt-5.5',
              displayName: 'GPT-5.5',
              isDefault: true
            },
            {
              model: 'gpt-5-codex',
              displayName: 'GPT-5 Codex'
            },
            {
              model: 'hidden-model',
              displayName: 'Hidden',
              hidden: true
            }
          ],
          nextCursor: 'next'
        },
        {
          data: [
            {
              model: 'gpt-5.5',
              displayName: 'Duplicate'
            },
            {
              model: 'gpt-5.4',
              display_name: 'GPT-5.4',
              max_context_window: 1_000_000
            }
          ],
          nextCursor: null
        }
      ],
      new Map([['gpt-5.5', 272_000]])
    )

    expect(models).toEqual({
      choices: [
        { value: 'gpt-5.5', label: 'GPT-5.5', contextWindowTokens: 272_000 },
        { value: 'gpt-5.4', label: 'GPT-5.4', contextWindowTokens: 1_000_000 }
      ],
      defaultContextWindowTokens: 272_000
    })
  })

  test('does not invent a Codex context window when runtime/catalog metadata is missing', () => {
    expect(contextWindow('gpt-future', 'codex')).toBeUndefined()
    expect(
      contextWindow('gpt-future', 'codex', [
        { value: 'gpt-future', label: 'GPT Future', contextWindowTokens: 512_000 }
      ])
    ).toBe(512_000)
  })
})

import {
  codexLatestUsageFromJsonl,
  codexUsageFromTokenCountPayload
} from '../src/main/services/codexImport'

test.describe('Codex usage parsing', () => {
  test('uses total_tokens as context used and preserves the model context window', () => {
    const usage = codexUsageFromTokenCountPayload({
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 176_660,
          cached_input_tokens: 166_272,
          output_tokens: 593,
          total_tokens: 177_253
        },
        model_context_window: 258_400
      }
    })

    expect(usage).toEqual({
      kind: 'usage',
      contextTokens: 177_253,
      contextWindowTokens: 258_400,
      inputTokens: 176_660,
      outputTokens: 593
    })
  })

  test('replays the latest token_count from Codex JSONL history', () => {
    const first = JSON.stringify({
      timestamp: '2026-07-08T22:08:31.350Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 166_526, output_tokens: 257, total_tokens: 166_783 },
          model_context_window: 258_400
        }
      }
    })
    const second = JSON.stringify({
      timestamp: '2026-07-08T22:08:44.455Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 176_660, output_tokens: 593, total_tokens: 177_253 },
          model_context_window: 258_400
        }
      }
    })

    const usage = codexLatestUsageFromJsonl(`${first}\n{"bad trailing json"\n${second}\n`)

    expect(usage?.kind).toBe('usage')
    expect(usage?.contextTokens).toBe(177_253)
    expect(usage?.contextWindowTokens).toBe(258_400)
  })
})
