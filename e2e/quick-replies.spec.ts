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
  expect(out.options.map((o) => o.value)).toEqual(['A', 'B', 'C'])
  expect(out.options[0].text).toContain('Every address with a coverage point')
})

test('a list the agent is merely reasoning through is not a question', () => {
  const out = quickReplies(
    'Here is what changed.\n\nA) I moved the file.\nB) I fixed the test.\n\nBoth are committed.'
  )
  expect(out.options).toEqual([])
})

test('one option is not a choice', () => {
  expect(quickReplies('Shall I proceed?\n\nA) Yes, go ahead.').options).toEqual([])
})

test('markdown emphasis and trailing rationale are stripped from the face', () => {
  const out = quickReplies('Which?\n\n- **A)** Hold F69 — it lands after E56 merges.\n- **B)** Ship now.')
  expect(out.options[0]).toEqual({ value: 'A', text: 'Hold F69' })
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
    await expect(replies.first().locator('.quick-reply-key')).toHaveText('A')
    await expect(replies.first()).toContainText('Every address with a coverage point')
    // the question is shown above the choices, not left to memory
    await expect(tile.locator('.quick-replies-title')).toContainText('Which scope')

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
  expect(out.options.map((o) => o.value)).toEqual(['A', 'B', 'C'])
  expect(out.options[1].text).toContain('Drop the gate')
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
  expect(out.options).toEqual([])
})

/**
 * The two false positives Angel hit. A long message is full of numbered lists
 * that are CONTENT — rules, screens, steps — and a looser rule turned them into
 * answers to a yes/no question asked further down.
 */
test('a numbered list of rules is not an answer to a later yes/no question', () => {
  const out = quickReplies(
    [
      'Two rules',
      '',
      '1. Balance starts at 0 for everyone on go-live. History before that is not counted.',
      '2. A visit with none left is allowed and drives the balance negative.',
      '',
      'Does section 1 look right?'
    ].join('\n')
  )
  expect(out.options).toEqual([])
})

test('a numbered list of screens is not an answer', () => {
  const out = quickReplies(
    [
      'Does section 2 look right?',
      '',
      'Section 3 of 5: UI shell and screens.',
      '',
      'Screens, in the order staff use them',
      '',
      '1. **Dashboard**. Section 4.',
      '2. **Patients**. List with search and filter.',
      '5. **Costs**. Date, branch, category, amount.',
      '',
      'Does section 3 look right?'
    ].join('\n')
  )
  expect(out.options).toEqual([])
})

test('a yes/no question on its own offers nothing', () => {
  expect(quickReplies('I rewrote the loader and the tests pass.\n\nDoes that look right?').options).toEqual([])
})

/** The LAST question is the live one — an earlier one has been answered. */
test('choices attach to the last question, not the first', () => {
  const out = quickReplies(
    [
      'Does section 2 look right?',
      '',
      'Now, which storage should the cache use?',
      '',
      'A. In memory, lost on restart.',
      'B. On disk under the worktree.'
    ].join('\n')
  )
  expect(out.options.map((o) => o.value)).toEqual(['A', 'B'])
})
