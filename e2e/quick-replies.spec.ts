import { test, expect } from '@playwright/test'
import { quickReplies } from '../src/renderer/src/quickReplies'
import { launchApp, makeScratchRepo, createProject } from './helpers'

/**
 * Angel: "clickable questions are a must have." AskUserQuestion is not offered
 * to agents outside an interactive terminal — zero calls across 59 sessions — so
 * the options have to come from the prose the agent actually writes.
 */
test('lettered options under a closing question become choices', () => {
  const out = quickReplies(
    [
      'Q2 of 6 — which addresses are in scope?',
      '',
      'A) Every address with a coverage point — no lifecycle filter.',
      'B) Only addresses that would show on the dashboard — go through utilityPartnerAddresses.',
      'C) B, plus optional operator narrowing params.',
      '',
      'A, B, or C?'
    ].join('\n')
  )
  expect(out.map((o) => o.value)).toEqual(['A', 'B', 'C'])
  expect(out[0].text).toContain('Every address with a coverage point')
})

test('numbered options work the same', () => {
  const out = quickReplies('Which one?\n\n1. Rebase onto main\n2. Merge main in\n')
  expect(out.map((o) => o.value)).toEqual(['1', '2'])
})

test('a list the agent is merely reasoning through is not a question', () => {
  const out = quickReplies(
    'Here is what changed.\n\nA) I moved the file.\nB) I fixed the test.\n\nBoth are committed.'
  )
  expect(out).toEqual([])
})

test('one option is not a choice', () => {
  expect(quickReplies('Shall I proceed?\n\nA) Yes, go ahead.')).toEqual([])
})

test('markdown emphasis and trailing rationale are stripped from the face', () => {
  const out = quickReplies('Which?\n\n- **A)** Hold F69 — it lands after E56 merges.\n- **B)** Ship now.')
  expect(out[0].text).toBe('A · Hold F69')
})

/** The buttons must actually answer: clicking one sends that reply. */
test('a prose question renders clickable options that send the answer', async () => {
  const launched = await launchApp()
  try {
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await page.locator('.dialog-prompt').fill('offer me options')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    const replies = tile.locator('.quick-reply')
    await expect(replies).toHaveCount(3, { timeout: 10_000 })
    await expect(replies.first()).toContainText('A ·')

    await replies.nth(1).click()
    // the pick is sent as the next user message
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const st = (
              window as unknown as {
                __hang4r_store: {
                  getState(): {
                    sessions: { id: string }[]
                    transcripts: Record<string, { items: { type: string; text?: string }[] }>
                  }
                }
              }
            ).__hang4r_store.getState()
            const items = st.transcripts[st.sessions[0].id]?.items ?? []
            return [...items].reverse().find((i) => i.type === 'user')?.text ?? ''
          }),
        { timeout: 15_000 }
      )
      .toBe('B')
  } finally {
    await launched.app.close().catch(() => {})
  }
})

/**
 * The shape Angel actually met: the question sits mid-message, the options
 * follow, and a recommendation comes after them. Requiring the message to END
 * with "?" meant a real question produced no buttons.
 */
test('options are found when a recommendation follows them', () => {
  const out = quickReplies(
    [
      'Question 2, about the batching flow. Today the job blocks on a gate.',
      '',
      'Which matches how the sites really operate?',
      '',
      '- **A.** Keep the gate as a hard requirement, one per site per day.',
      '- **B.** Drop the gate; capture events as they happen.',
      '- **C.** Some sites do A, others do B.',
      '',
      'My recommendation is B unless someone is actually reconciling by hand.'
    ].join('\n')
  )
  expect(out.map((o) => o.value)).toEqual(['A', 'B', 'C'])
  expect(out[1].text).toContain('Drop the gate')
})

test('options listed BEFORE any question are still ignored', () => {
  const out = quickReplies(
    [
      'Here is what I considered.',
      '',
      'A) Rebase onto main.',
      'B) Merge main in.',
      '',
      'I went with the rebase. Does that look right to you?'
    ].join('\n')
  )
  expect(out).toEqual([])
})
