import { test, expect } from '@playwright/test'
import { buildHandoffSeed } from '../src/main/services/handoff'
import { AUTO_CONTINUE_LABEL, sentUserText, shownUserText } from '../src/shared/userText'

/**
 * hang4r stored the label it displays as the user's own text, so every replay
 * path — retry, handoff seeds, rewind anchors — handed the agent hang4r's UI
 * copy attributed to the user. 214 such turns were already on disk.
 */
test('an auto-recovery turn replays as what was sent, not what was shown', () => {
  const modern = { text: 'continue', label: AUTO_CONTINUE_LABEL }
  expect(sentUserText(modern)).toBe('continue')
  expect(shownUserText(modern)).toBe(AUTO_CONTINUE_LABEL)

  // recorded before `label` existed — the label sits in `text`
  const legacy = { text: AUTO_CONTINUE_LABEL }
  expect(sentUserText(legacy)).toBe('continue')
})

test('a real user message is untouched by either path', () => {
  const ev = { text: 'fix the failing test' }
  expect(sentUserText(ev)).toBe('fix the failing test')
  expect(shownUserText(ev)).toBe('fix the failing test')
})

test('a handoff seed never quotes hang4r UI copy as the user', () => {
  const seed = buildHandoffSeed(
    [
      { kind: 'user-text', text: 'start the work' },
      { kind: 'user-text', text: AUTO_CONTINUE_LABEL },
      { kind: 'user-text', text: 'continue', label: AUTO_CONTINUE_LABEL }
    ] as Parameters<typeof buildHandoffSeed>[0],
    'claude'
  )
  expect(seed).not.toContain('hang4r auto-recovery')
  expect(seed).toContain('start the work')
})
