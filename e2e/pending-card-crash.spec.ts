// A pending permission/question card must go DEAD when the agent process exits
// (crash, kill, SSH drop) — that path emits NO turn-complete, so without the
// exit-reducer the card stayed clickable for a request nobody can answer and the
// sidebar "needs you" dot stayed lit even as the session flipped to error. This
// is the round-8 permission-card bug, which had only been fixed on the
// turn-complete path. Pure reducer unit tests (no Electron) — deterministic.
import { expect, test } from '@playwright/test'
import {
  applyEvent,
  isAwaitingPermission,
  isAwaitingQuestion,
  type Transcript,
  type TranscriptItem
} from '../src/renderer/src/state/store'

function emptyT(): Transcript {
  return { items: [], blockIndex: new Map(), toolIndex: new Map(), hooks: [], lastSeq: 0 }
}

test.describe('agent process exit cancels pending permission/question cards', () => {
  test('a pending PERMISSION is cancelled when the process exits', () => {
    const t = emptyT()
    applyEvent(t, {
      kind: 'permission-request',
      requestId: 'r1',
      tool: 'Bash',
      summary: 'rm -rf',
      options: ['allow', 'deny']
    })
    expect(isAwaitingPermission(t)).toBe(true)

    // the process dies mid-decision — no turn-complete, just an exit
    applyEvent(t, { kind: 'exit', code: 1 })

    expect(isAwaitingPermission(t)).toBe(false)
    const perm = t.items.find((i): i is Extract<TranscriptItem, { type: 'permission' }> => i.type === 'permission')
    expect(perm?.decision).toBe('cancelled')
  })

  test('a pending QUESTION is cancelled when the process exits', () => {
    const t = emptyT()
    applyEvent(t, {
      kind: 'question-request',
      requestId: 'q1',
      title: 'Pick',
      questions: [{ id: '0', prompt: 'Color?', options: [{ id: 'Red', label: 'Red' }] }]
    })
    expect(isAwaitingQuestion(t)).toBe(true)

    applyEvent(t, { kind: 'exit', code: null })

    expect(isAwaitingQuestion(t)).toBe(false)
    const q = t.items.find((i): i is Extract<TranscriptItem, { type: 'question' }> => i.type === 'question')
    expect(q?.cancelled).toBe(true)
  })

  test('an already-ANSWERED question is not clobbered by a later exit', () => {
    const t = emptyT()
    applyEvent(t, {
      kind: 'question-request',
      requestId: 'q1',
      questions: [{ id: '0', prompt: 'Color?', options: [{ id: 'Red', label: 'Red' }] }]
    })
    applyEvent(t, {
      kind: 'question-resolved',
      requestId: 'q1',
      answers: [{ questionId: '0', optionIds: ['Red'] }]
    })
    applyEvent(t, { kind: 'exit', code: 0 })

    const q = t.items.find((i): i is Extract<TranscriptItem, { type: 'question' }> => i.type === 'question')
    expect(q?.answers).toEqual([{ questionId: '0', optionIds: ['Red'] }])
    expect(q?.cancelled).toBeFalsy()
    expect(isAwaitingQuestion(t)).toBe(false)
  })

  test('an already-DECIDED permission keeps its decision through an exit', () => {
    const t = emptyT()
    applyEvent(t, {
      kind: 'permission-request',
      requestId: 'r1',
      tool: 'Bash',
      summary: 'ls',
      options: ['allow', 'deny']
    })
    applyEvent(t, { kind: 'permission-resolved', requestId: 'r1', decision: 'allow' })
    applyEvent(t, { kind: 'exit', code: 0 })

    const perm = t.items.find((i): i is Extract<TranscriptItem, { type: 'permission' }> => i.type === 'permission')
    expect(perm?.decision).toBe('allow')
    expect(isAwaitingPermission(t)).toBe(false)
  })
})
