// Cursor (cursor-agent) integration unit specs (stream translation, model
// discovery, import parsing) + an opt-in real-CLI smoke. Fixtures are trimmed
// from live captures (docs/cursor-agent-protocol.md; scratchpad stream1/stream3).
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { makeScratchRepo, createProject } from './helpers'
import {
  translateCursorEvent,
  CursorState,
  resolvePromptAction,
  resolveExitAction,
  shouldEscalateDrain,
  describeBlockedQuestion
} from '../src/main/services/adapters/cursorAdapter'
import type { AgentEvent } from '../src/shared/protocol'

/** Drive a sequence of raw cursor lines through the pure translator. */
function run(raw: Record<string, unknown>[]): AgentEvent[] {
  const state = new CursorState()
  const out: AgentEvent[] = []
  for (const r of raw) out.push(...translateCursorEvent(r, state))
  return out
}

test.describe('cursor-agent stream translation', () => {
  test('maps init → init (session_id, model, permissionMode)', () => {
    const [ev] = run([
      {
        type: 'system',
        subtype: 'init',
        session_id: '3a15d1f4-7f75-45d5-a193-01f391cbaf9a',
        model: 'Auto',
        permissionMode: 'default'
      }
    ])
    expect(ev).toMatchObject({
      kind: 'init',
      backendSessionId: '3a15d1f4-7f75-45d5-a193-01f391cbaf9a',
      model: 'Auto',
      permissionMode: 'default',
      version: 'cursor-agent'
    })
  })

  test('drops the prompt-echo user event (we echo prompts ourselves)', () => {
    expect(
      run([{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }])
    ).toEqual([])
  })

  test('streams text deltas and dedupes the full-text repeat into one final block', () => {
    const events = run([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CUR' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SOR' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '_OK' }] } },
      // cursor repeats the FULL segment text as a final chunk — must be deduped
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CURSOR_OK' }] } }
    ])
    const deltas = events.filter((e) => e.kind === 'block-delta')
    const finals = events.filter((e) => e.kind === 'block-final')
    expect(deltas.map((d) => (d.kind === 'block-delta' ? d.text : ''))).toEqual(['CUR', 'SOR', '_OK'])
    expect(finals).toHaveLength(1)
    expect(finals[0]).toMatchObject({ block: { type: 'text', text: 'CURSOR_OK' } })
    // delta stream and its final share one messageId so the renderer merges them
    expect((deltas[0] as { messageId: string }).messageId).toBe(
      (finals[0] as { messageId: string }).messageId
    )
  })

  test('thinking deltas accumulate then finalize on completed', () => {
    const events = run([
      { type: 'thinking', subtype: 'delta', text: 'Prep' },
      { type: 'thinking', subtype: 'delta', text: 'aring' },
      { type: 'thinking', subtype: 'completed' }
    ])
    expect(events.filter((e) => e.kind === 'block-delta')).toHaveLength(2)
    const final = events.find((e) => e.kind === 'block-final')
    expect(final).toMatchObject({ block: { type: 'thinking', thinking: 'Preparing' } })
  })

  test('shell tool_call → Bash tool_use; rejected completion → blocked tool-result', () => {
    const callId = 'tool_699ee4fc-7b3d-4b51-933c-76177246f3a'
    const events = run([
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: callId,
        tool_call: {
          shellToolCall: {
            args: {
              command: 'mkfifo ./probe_fifo_c && echo made',
              workingDirectory: '/tmp/cursorprobe'
            }
          },
          toolCallId: callId,
          startedAtMs: '1783708861245'
        }
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: callId,
        tool_call: {
          shellToolCall: {
            result: { rejected: { command: 'mkfifo ./probe_fifo_c && echo made', reason: '' } }
          },
          toolCallId: callId,
          completedAtMs: '1783708861484'
        }
      }
    ])
    const toolUse = events.find((e) => e.kind === 'block-final')
    expect(toolUse).toMatchObject({
      block: {
        type: 'tool_use',
        id: callId,
        name: 'Bash',
        input: { command: 'mkfifo ./probe_fifo_c && echo made', cwd: '/tmp/cursorprobe' }
      }
    })
    const result = events.find((e) => e.kind === 'tool-result')
    expect(result).toMatchObject({
      toolUseId: callId,
      content: "Blocked by Cursor's policy",
      isError: true
    })
  })

  // cursor-agent's headless (-p) mode auto-REJECTS an interactive ask/question
  // tool (there is no channel to answer it). Rather than a bare "Blocked by
  // Cursor's policy", we surface WHAT it wanted to ask so the user at least sees
  // the question. The structured shape the user reported:
  // {title, questions:[{id,prompt,options:[{id,label}],allowMultiple}]}.
  test('a rejected ask-user/question tool renders the question TEXT + options, not the bare policy string', () => {
    const callId = 'tool_ask_1'
    const questionArgs = {
      title: 'Choose an approach',
      questions: [
        {
          id: 'q1',
          prompt: 'Which framework should I scaffold with?',
          options: [
            { id: 'a', label: 'Next.js' },
            { id: 'b', label: 'Remix' }
          ],
          allowMultiple: false
        }
      ],
      runAsync: false
    }
    const events = run([
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: callId,
        tool_call: { askUserToolCall: { args: questionArgs }, toolCallId: callId }
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: callId,
        // completed omits args (mirrors the shell shape); rejected echoes reason.
        // the question text is recovered from the started args stashed by callId.
        tool_call: { askUserToolCall: { result: { rejected: { reason: '' } } }, toolCallId: callId }
      }
    ])
    const result = events.find((e) => e.kind === 'tool-result')
    expect(result).toMatchObject({ toolUseId: callId, isError: true })
    const content = (result as { content: string }).content
    expect(content).toContain('blocked in headless mode')
    expect(content).toContain('Which framework should I scaffold with?')
    expect(content).toContain('Next.js')
    expect(content).toContain('Remix')
    // NOT the bare policy string
    expect(content).not.toBe("Blocked by Cursor's policy")
  })

  test('a genuinely non-question rejection keeps the plain policy string', () => {
    const callId = 'tool_shell_block'
    const events = run([
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: callId,
        tool_call: {
          shellToolCall: { result: { rejected: { command: 'rm -rf /', reason: '' } } },
          toolCallId: callId
        }
      }
    ])
    const result = events.find((e) => e.kind === 'tool-result')
    expect(result).toMatchObject({
      toolUseId: callId,
      content: "Blocked by Cursor's policy",
      isError: true
    })
  })

  test('describeBlockedQuestion: reads the question off the rejected payload too', () => {
    // some tools echo the question INSIDE the rejected payload (like shell echoes
    // its command) — detect it there when the started args weren't captured
    const msg = describeBlockedQuestion(
      'AskUser',
      undefined,
      { title: 'Pick one', questions: [{ prompt: 'Deploy target?', options: [{ label: 'prod' }, { label: 'staging' }] }] }
    )
    expect(msg).toContain('Pick one')
    expect(msg).toContain('Deploy target?')
    expect(msg).toContain('prod')
    expect(msg).toContain('staging')
  })

  test('describeBlockedQuestion: returns null for a non-question rejection (plain command)', () => {
    expect(describeBlockedQuestion('Shell', { command: 'ls -la' }, { command: 'ls -la', reason: '' })).toBeNull()
  })

  test('a successful (non-rejected) shell completion passes the result through, not errored', () => {
    const callId = 'tool_86439361-ae2c-4fbc-8db0-e6584c428f0'
    const events = run([
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: callId,
        tool_call: {
          shellToolCall: {
            result: { success: { command: 'touch ./ok', exitCode: 0, stdout: '', stderr: '' } }
          },
          toolCallId: callId
        }
      }
    ])
    const result = events.find((e) => e.kind === 'tool-result')
    expect(result).toMatchObject({ toolUseId: callId, isError: false })
    expect((result as { content: { success?: unknown } }).content).toHaveProperty('success')
  })

  test('result → turn-complete with context/usage totals', () => {
    const events = run([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'CURSOR_OK',
        usage: { inputTokens: 31_334, outputTokens: 483, cacheReadTokens: 80_010, cacheWriteTokens: 0 }
      }
    ])
    const done = events.find((e) => e.kind === 'turn-complete')
    expect(done).toMatchObject({
      kind: 'turn-complete',
      isError: false,
      result: 'CURSOR_OK',
      inputTokens: 31_334,
      outputTokens: 483,
      contextTokens: 31_334 + 80_010
    })
  })

  test('an open text segment still finalizes if result arrives before a repeat', () => {
    const events = run([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'partial' }
    ])
    const final = events.find((e) => e.kind === 'block-final')
    expect(final).toMatchObject({ block: { type: 'text', text: 'partial' } })
  })
})

// The Cursor queue-race state machine (Angel round 13 ③). cursor-agent spawns a
// child per turn and emits `result` (→ turn-complete → renderer flushes the
// queue) BEFORE the child exits; a prompt landing in that drain gap must be
// buffered, not rejected as "still working". This pure helper is that decision.
test.describe('cursor prompt action (queue drain-gap race)', () => {
  test('no live child → spawn immediately', () => {
    expect(resolvePromptAction(false, false)).toBe('spawn')
    // sawResult is irrelevant once the child is gone (state resets per turn)
    expect(resolvePromptAction(false, true)).toBe('spawn')
  })

  test('child alive but result already seen → buffer (drain gap, not an error)', () => {
    // this is the race: the turn is DONE, the child is just draining to exit —
    // hold the prompt for the exit handler instead of falsely erroring
    expect(resolvePromptAction(true, true)).toBe('buffer')
  })

  test('child alive, no result yet → reject (a genuine concurrent turn)', () => {
    expect(resolvePromptAction(true, false)).toBe('reject')
  })
})

// The Cursor Stop path (Angel: "I cannot stop a Cursor agent"). Headless
// cursor-agent has no in-band interrupt, so Stop kills the child (SIGTERM →
// SIGKILL escalation); its exit is resolved here. A kill mid-turn has no
// `result`, so it settles as 'interrupted' and the UI unsticks.
test.describe('cursor exit action (Stop / interrupt state machine)', () => {
  test('killed mid-turn (no result) → synthesize interrupted so the UI settles', () => {
    // Stop SIGTERM/SIGKILLs the child before any `result` arrived; nothing queued
    expect(resolveExitAction(false, false, false)).toEqual({
      synthInterrupted: true,
      spawnPending: false
    })
  })

  test('clean finish (result seen, nothing queued) → neither synth nor spawn', () => {
    expect(resolveExitAction(true, false, false)).toEqual({
      synthInterrupted: false,
      spawnPending: false
    })
  })

  test('normal drain: result seen + a buffered follow-up → spawn it, no synth', () => {
    expect(resolveExitAction(true, false, true)).toEqual({
      synthInterrupted: false,
      spawnPending: true
    })
  })

  test('interrupt leaves the buffer intact: a held follow-up still spawns from exit', () => {
    // interrupt() does NOT clear the buffer, so a genuinely-held follow-up still
    // spawns after the child dies (unchanged from the drain-gap design)
    expect(resolveExitAction(true, false, true).spawnPending).toBe(true)
  })

  test('disposed: teardown suppresses both a synth and any pending spawn', () => {
    expect(resolveExitAction(false, true, true)).toEqual({
      synthInterrupted: false,
      spawnPending: false
    })
  })
})

// Round 8 follow-up ③: the drain-gap watchdog. If cursor-agent emits `result`
// but the child never exits, a buffered prompt would wait forever — the
// watchdog escalates (SIGKILLs the process group) so `exit` fires. This is the
// pure "should it escalate" decision the timer callback consults; the timer
// wiring itself and the actual group-kill are impure (real setTimeout + a real
// child pid) and aren't covered here — see the note below.
test.describe('cursor drain watchdog (should it escalate)', () => {
  test('prompt still buffered, child still alive → escalate', () => {
    expect(shouldEscalateDrain(true, false)).toBe(true)
  })

  test('child already exited naturally → no escalation needed', () => {
    expect(shouldEscalateDrain(true, true)).toBe(false)
  })

  test('nothing buffered anymore (already spawned/cleared) → never escalate', () => {
    expect(shouldEscalateDrain(false, false)).toBe(false)
    expect(shouldEscalateDrain(false, true)).toBe(false)
  })
})

import { parseCursorModels } from '../src/main/services/cursorModelService'
import {
  contextWindow,
  normalizeCursorModelName,
  parseBracketContextOverride
} from '../src/renderer/src/contextWindow'

test.describe('cursor-agent model discovery', () => {
  test('parses --list-models plain text, folding auto into the default entry', () => {
    const text = [
      'Available models',
      '',
      'auto - Auto (current, default)',
      'gpt-5.2 - GPT-5.2',
      'claude-fable-5-thinking-high - Fable 5 1M Thinking (NO ZDR)'
    ].join('\n')
    expect(parseCursorModels(text)).toEqual([
      { value: 'gpt-5.2', label: 'GPT-5.2' },
      { value: 'claude-fable-5-thinking-high', label: 'Fable 5 1M Thinking (NO ZDR)' }
    ])
  })

  // Verified 2026-07-12 against cursor.com/docs/models, cursor.com/docs/context/max-mode,
  // the Composer 2.5 changelog/blog, and Cursor staff forum replies: Cursor does not
  // publish a fixed per-model context window anywhere (the models table page even claims
  // to show one and doesn't). The only official number is generic — Max Mode docs say
  // "the default context window ~200k tokens" — and cursor-agent has no CLI flag to report
  // or toggle Max Mode, so a blanket 200k would be a guess, not a sourced fact. A known
  // slug with no embedded size hint correctly stays undefined (raw-token fallback).
  test('a known cursor slug with no self-reported size stays undefined (v1 reports none)', () => {
    expect(contextWindow('gpt-5.2', 'cursor')).toBeUndefined()
    expect(contextWindow('composer-2.5', 'cursor')).toBeUndefined()
    expect(contextWindow('claude-fable-5-thinking-high', 'cursor')).toBeUndefined()
  })

  test('an unknown/made-up slug also stays undefined', () => {
    expect(contextWindow('totally-invented-model-9000', 'cursor')).toBeUndefined()
  })

  // cursor-agent's own --list-models label sometimes spells the window out
  // directly (verified live: "Fable 5 1M Thinking (NO ZDR)"); session init events
  // carry that same string as `model`, so we read it straight off the name.
  test('reads a self-reported window off the model display name', () => {
    expect(contextWindow('Fable 5 1M Thinking (NO ZDR)', 'cursor')).toBe(1_000_000)
    expect(contextWindow('Grok 256K Fast', 'cursor')).toBe(256_000)
  })

  test('bracket context override wins over everything else', () => {
    expect(contextWindow('claude-opus-4-8[context=1m,effort=high]', 'cursor')).toBe(1_000_000)
    expect(contextWindow('composer-2.5[context=200k]', 'cursor')).toBe(200_000)
  })

  test('parseBracketContextOverride parses k/m suffixes case-insensitively', () => {
    expect(parseBracketContextOverride('claude-opus-4-8[context=1m,effort=high]')).toBe(1_000_000)
    expect(parseBracketContextOverride('model[CONTEXT=200K]')).toBe(200_000)
    expect(parseBracketContextOverride('model[context=1M]')).toBe(1_000_000)
    expect(parseBracketContextOverride('plain-model')).toBeUndefined()
  })

  test('normalizeCursorModelName lowercases and turns spaces into dashes', () => {
    expect(normalizeCursorModelName('Composer 2.5')).toBe('composer-2.5')
    expect(normalizeCursorModelName('composer-2.5')).toBe('composer-2.5')
    expect(normalizeCursorModelName('  GPT-5.2  ')).toBe('gpt-5.2')
  })
})

import {
  cursorTranscriptFromJsonl,
  parseCursorUserText
} from '../src/main/services/cursorAgentImport'

test.describe('cursor-agent import parsing', () => {
  test('unwraps user_query and strips timestamp/thinking wrappers', () => {
    expect(
      parseCursorUserText('<timestamp>Friday, Jul 10, 2026</timestamp>\n<user_query>\nDo the thing\n</user_query>')
    ).toBe('Do the thing')
    expect(parseCursorUserText('<timestamp>x</timestamp>\nplain text')).toBe('plain text')
  })

  test('reads an ordered transcript from the agent-transcript JSONL', () => {
    const jsonl = [
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '<user_query>Run it</user_query>' }] }
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'redacted-reasoning', data: 'x' }, { type: 'text', text: 'Done.' }] }
      }),
      JSON.stringify({ type: 'turn_ended', status: 'success' })
    ].join('\n')
    expect(cursorTranscriptFromJsonl(jsonl)).toEqual([
      { role: 'user', text: 'Run it' },
      { role: 'assistant', text: 'Done.' }
    ])
  })
})

import { parseCursorAbout } from '../src/main/services/usageService'

test.describe('cursor-agent `about` parsing (sidebar usage pane)', () => {
  test('parses tier/email/model/version from a verbatim `cursor-agent about` capture', () => {
    const stdout = [
      'About Cursor CLI',
      'CLI Version         2026.07.09-a3815c0',
      'Model               Composer 2.5',
      'Subscription Tier   Free',
      'OS                  darwin (arm64)',
      'Node Version        v22.22.2',
      'User Email          angel.malavar@gmail.com'
    ].join('\n')

    expect(parseCursorAbout(stdout)).toEqual({
      tier: 'Free',
      email: 'angel.malavar@gmail.com',
      model: 'Composer 2.5',
      version: '2026.07.09-a3815c0'
    })
  })

  test('parses ANSI-colorized output (what the CLI emits under Electron)', () => {
    // verbatim capture from inside the app's main process — FORCE_COLOR leaks
    // into the child env, so labels arrive dim (\x1b[2m…\x1b[22m) and the
    // header cyan+bold; this exact output made the sidebar pane show
    // "Account info unavailable" (Angel's report, Jul 10)
    const stdout =
      '\x1b[1m\x1b[36mAbout Cursor CLI\x1b[39m\x1b[22m\n\n' +
      '\x1b[2mCLI Version         \x1b[22m2026.07.09-a3815c0\n' +
      '\x1b[2mModel               \x1b[22mComposer 2.5\n' +
      '\x1b[2mSubscription Tier   \x1b[22mPro+\n' +
      '\x1b[2mOS                  \x1b[22mdarwin (arm64)\n' +
      '\x1b[2mUser Email          \x1b[22mangel@utilityprofit.com\n'

    expect(parseCursorAbout(stdout)).toEqual({
      tier: 'Pro+',
      email: 'angel@utilityprofit.com',
      model: 'Composer 2.5',
      version: '2026.07.09-a3815c0'
    })
  })

  test('garbage input returns all-null fields without throwing', () => {
    expect(parseCursorAbout('')).toEqual({ tier: null, email: null, model: null, version: null })
    expect(parseCursorAbout('not even close to the real format\n{}\n😀')).toEqual({
      tier: null,
      email: null,
      model: null,
      version: null
    })
  })
})

/**
 * REAL cursor-agent smoke (opt-in, costs one tiny turn on the user's Cursor
 * plan + needs a logged-in cursor-agent):
 *   HANG4R_REAL_E2E=1 npx playwright test e2e/cursor.spec.ts -g "real cursor"
 */
test.describe('real cursor session', () => {
  test.skip(process.env.HANG4R_REAL_E2E !== '1', 'set HANG4R_REAL_E2E=1 to run')
  test.setTimeout(240_000)

  test('one real turn streams text and settles idle with the cursor backend', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'hang4r-real-cursor-'))
    const app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, HANG4R_FAKE_AGENT: '0', HANG4R_USER_DATA_DIR: userDataDir, HANG4R_QUIET_TEST: '1' }
    })
    const page = await app.firstWindow()
    await page.waitForSelector('.app', { timeout: 20_000 })

    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    // pick the Cursor backend, run in-place (no worktree churn)
    await page.locator('.segmented button', { hasText: 'Cursor' }).click()
    await page.locator('.segmented button', { hasText: 'In-place' }).click()
    await page.locator('.dialog-prompt').fill('Reply with exactly the word CURSOR_OK and nothing else.')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(tile.locator('.msg-assistant')).toContainText('CURSOR_OK', { timeout: 180_000 })
    await expect(tile.locator('.msg-user-card')).toHaveCount(1)
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 60_000 })

    const session = (await page.evaluate(() => window.hang4r.listSessions()))[0]
    expect(session.backend).toBe('cursor')
    expect(session.backendSessionId).toBeTruthy()

    await page.screenshot({ path: 'test-results/real-cursor.png', fullPage: true })
    await app.close()
  })
})
