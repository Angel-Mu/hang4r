import { test, expect } from '@playwright/test'
import {
  prettifyClaudeModelId,
  CLAUDE_MODELS,
  CURRENT_CLAUDE_VERSIONS
} from '../src/renderer/src/modelChoices'

/**
 * Claude model labels must not hard-code a version that goes stale (Angel: the
 * picker showed "Opus 4.8" while his CLI already ran Opus 5). The base labels are
 * version-agnostic; prettifyClaudeModelId derives the real version from the id
 * the CLI's init event reports, so the picker shows what actually runs.
 */
test('base Claude labels are version-agnostic (nothing to go stale)', () => {
  const labels = CLAUDE_MODELS.map((m) => m.label)
  expect(labels).toEqual(['Default model', 'Opus', 'Sonnet', 'Fable', 'Haiku'])
  // no hard-coded version numbers on the alias options
  for (const m of CLAUDE_MODELS) expect(m.label).not.toMatch(/\d/)
})

test('every named alias has a current-lineup version so the picker is never blank', () => {
  // Angel: only the running model ("Fable 5") showed a number; the rest didn't.
  for (const alias of ['opus', 'sonnet', 'fable', 'haiku']) {
    expect(CURRENT_CLAUDE_VERSIONS[alias]).toMatch(/^[A-Z][a-z]+ \d/) // e.g. "Opus 5"
  }
})

test('prettifyClaudeModelId derives the display name from a resolved id', () => {
  expect(prettifyClaudeModelId('claude-opus-5-20260115')).toBe('Opus 5')
  expect(prettifyClaudeModelId('claude-opus-4-8')).toBe('Opus 4.8')
  expect(prettifyClaudeModelId('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(prettifyClaudeModelId('claude-sonnet-5')).toBe('Sonnet 5')
  // a thinking/1M suffix is dropped, family+version kept
  expect(prettifyClaudeModelId('claude-fable-5-thinking-high')).toBe('Fable 5')
})
