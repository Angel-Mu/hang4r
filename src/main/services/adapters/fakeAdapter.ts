import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, PromptImage, QuestionAnswer } from '../../../shared/protocol'
import type { AdapterStartOptions, AgentAdapter } from './types'

/**
 * Deterministic in-process agent for end-to-end tests. Enabled via the
 * HANG4R_FAKE_AGENT env var so the Playwright E2E suite (and the /loop
 * verification) can drive the full pipeline — streamed events, a tool call
 * that writes a real file (so the diff has content), and turn completion —
 * with no network, no tokens, and no native dialogs.
 */
export class FakeAdapter implements AgentAdapter {
  readonly backend = 'claude' as const
  private listeners: Array<(ev: AgentEvent) => void> = []
  private cwd = ''
  private turn = 0

  onEvent(cb: (ev: AgentEvent) => void): void {
    this.listeners.push(cb)
  }
  private emit(ev: AgentEvent): void {
    for (const cb of this.listeners) cb(ev)
  }

  start(opts: AdapterStartOptions): void {
    this.cwd = opts.cwd
    this.emit({
      kind: 'init',
      backendSessionId: 'fake-' + randomUUID(),
      model: opts.model || 'fake-model',
      tools: ['Write', 'Bash'],
      mcpServers: [{ name: 'playwright', status: 'connected' }],
      skills: ['artifact-design', 'brainstorming'],
      slashCommands: ['/review', '/loop'],
      plugins: [{ name: 'claude-mem' }],
      permissionMode: opts.permissionMode,
      version: 'fake'
    })
  }

  prompt(text: string, images?: PromptImage[]): void {
    this.turn += 1
    const turn = this.turn
    // carry images on the user event, exactly like the real adapters — so the
    // chat thumbnail (and its click-to-enlarge lightbox) is exercised in e2e
    this.emit({ kind: 'user-text', text, images })

    // deterministic error turn (mirrors Claude's error_during_execution abort)
    // so the suite can prove error recovery: the session goes to error, the
    // wedge-prone adapter is dropped, and the next prompt re-spawns cleanly.
    // Async (like the real turn-complete below) so it lands AFTER prompt()'s
    // caller sets status:'running' — a sync emit would be overwritten.
    if (text.includes('trigger error')) {
      setTimeout(() => {
        this.emit({ kind: 'turn-complete', isError: true, errorMessage: 'error_during_execution' })
      }, 20)
      return
    }

    const messageId = randomUUID()

    // a lifecycle hook firing around the turn (mirrors Claude's hook events)
    this.emit({
      kind: 'hook',
      phase: 'started',
      hookName: 'format-on-save',
      hookEvent: 'PostToolUse'
    })
    this.emit({
      kind: 'hook',
      phase: 'response',
      hookName: 'format-on-save',
      hookEvent: 'PostToolUse',
      outcome: 'allowed'
    })

    // streamed assistant text
    this.emit({
      kind: 'block-start',
      messageId,
      blockIndex: 0,
      blockType: 'text',
      parentToolUseId: null
    })
    for (const chunk of ['Working on ', 'it — ', `turn ${turn}.`]) {
      this.emit({ kind: 'block-delta', messageId, blockIndex: 0, text: chunk, parentToolUseId: null })
    }
    this.emit({
      kind: 'block-final',
      messageId,
      blockIndex: 0,
      block: { type: 'text', text: `Working on it — turn ${turn}.` },
      parentToolUseId: null
    })

    // a Task tool call spawning a subagent, with subagent messages carrying
    // parentToolUseId (mirrors Claude's real subagent attribution)
    const taskId = randomUUID()
    this.emit({
      kind: 'block-final',
      messageId,
      blockIndex: 1,
      block: {
        type: 'tool_use',
        id: taskId,
        // current Claude Code names the subagent tool `Agent` (was `Task`)
        name: 'Agent',
        input: { description: `explore for turn ${turn}`, subagent_type: 'Explore' }
      },
      parentToolUseId: null
    })
    const subMsg = randomUUID()
    this.emit({
      kind: 'block-final',
      messageId: subMsg,
      blockIndex: 0,
      block: { type: 'text', text: `Subagent scanned the repo (turn ${turn}) and found 2 matches.` },
      parentToolUseId: taskId
    })
    this.emit({
      kind: 'tool-result',
      toolUseId: taskId,
      content: 'subagent complete: 2 matches',
      isError: false,
      parentToolUseId: null
    })

    // exercise the answerable QUESTION loop when asked (covers the AskUserQuestion
    // card — Claude surfaces these as question-request events). Holds the turn
    // until respondQuestion, then continues, mirroring the permission hold.
    if (text.includes('ask a question')) {
      this.emit({
        kind: 'question-request',
        requestId: `fake-q-${turn}`,
        title: 'Pick an approach',
        questions: [
          {
            id: 'q1',
            prompt: 'Which color do you prefer?',
            options: [
              { id: 'red', label: 'Red' },
              { id: 'blue', label: 'Blue' }
            ],
            allowMultiple: false
          }
        ]
      })
      return // turn continues when the user answers (see respondQuestion)
    }

    // exercise the approval loop when asked (covers the inline permission UI);
    // AFTER the subagent work so a held turn shows live threads, like real runs
    if (text.includes('ask permission')) {
      this.emit({
        kind: 'permission-request',
        requestId: `fake-perm-${turn}`,
        tool: 'Bash',
        summary: 'Bash: rm -rf ./sandbox-test',
        options: ['allow', 'allow_session', 'allow_always', 'deny']
      })
      return // turn continues when the user decides (see respondPermission)
    }

    // a tool call that writes a real file so the Diff tab has content
    const toolUseId = randomUUID()
    const filename = `hang4r-fake-${turn}.txt`
    const content = `edit from fake agent, turn ${turn}\nprompt was: ${text.slice(0, 80)}\n`
    this.emit({
      kind: 'block-final',
      messageId,
      blockIndex: 2,
      block: { type: 'tool_use', id: toolUseId, name: 'Write', input: { file_path: filename } },
      parentToolUseId: null
    })
    try {
      writeFileSync(join(this.cwd, filename), content)
      this.emit({
        kind: 'tool-result',
        toolUseId,
        content: `wrote ${filename}`,
        isError: false,
        parentToolUseId: null
      })
    } catch (err) {
      this.emit({
        kind: 'tool-result',
        toolUseId,
        content: String(err),
        isError: true,
        parentToolUseId: null
      })
    }

    // a background bash task (run_in_background) so the Tasks panel has content
    const bgId = randomUUID()
    const bgLog = join(this.cwd, `.hang4r-bg-${turn}.log`)
    this.emit({
      kind: 'block-final',
      messageId,
      blockIndex: 3,
      block: {
        type: 'tool_use',
        id: bgId,
        name: 'Bash',
        input: {
          command: 'npm run dev',
          description: 'dev server',
          run_in_background: true
        }
      },
      parentToolUseId: null
    })
    try {
      writeFileSync(bgLog, `dev server starting…\nturn ${turn}\nlistening on :5173\n`)
    } catch {
      /* ignore */
    }
    this.emit({
      kind: 'tool-result',
      toolUseId: bgId,
      content: `Command running in background with ID: bg${turn}. Output is being written to: ${bgLog}`,
      isError: false,
      parentToolUseId: null
    })

    // the agent's structured task list (TaskCreate/TaskUpdate — TodoWrite's
    // successor) so the Tasks panel's list section has deterministic content
    const todoCreateId = randomUUID()
    this.emit({
      kind: 'block-final',
      messageId,
      blockIndex: 6,
      block: {
        type: 'tool_use',
        id: todoCreateId,
        name: 'TaskCreate',
        input: { subject: `fake task for turn ${turn}` }
      },
      parentToolUseId: null
    })
    this.emit({
      kind: 'tool-result',
      toolUseId: todoCreateId,
      content: `Created task #${turn}`,
      isError: false,
      parentToolUseId: null
    })
    if (turn > 1) {
      const todoUpdateId = randomUUID()
      this.emit({
        kind: 'block-final',
        messageId,
        blockIndex: 7,
        block: {
          type: 'tool_use',
          id: todoUpdateId,
          name: 'TaskUpdate',
          input: { taskId: String(turn - 1), status: 'completed' }
        },
        parentToolUseId: null
      })
      this.emit({
        kind: 'tool-result',
        toolUseId: todoUpdateId,
        content: `Updated task #${turn - 1} status`,
        isError: false,
        parentToolUseId: null
      })
    }

    // a Workflow run (mirrors /deep-research fanning out background agents)
    const wfId = randomUUID()
    this.emit({
      kind: 'block-final',
      messageId,
      blockIndex: 4,
      block: {
        type: 'tool_use',
        id: wfId,
        name: 'Workflow',
        input: { name: 'deep-research', description: 'research landing-page patterns' }
      },
      parentToolUseId: null
    })
    this.emit({
      kind: 'tool-result',
      toolUseId: wfId,
      content: `Workflow started. Run ID: wf_${turn}abcdef. You will be notified when it completes. Use /workflows to watch live progress.`,
      isError: false,
      parentToolUseId: null
    })

    // rate-limit events for BOTH account windows, so global gauges render
    this.emit({
      kind: 'rate-limit',
      rateLimitType: 'five_hour',
      status: 'allowed',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      isUsingOverage: false
    })
    this.emit({
      kind: 'rate-limit',
      rateLimitType: 'seven_day',
      status: 'warning',
      resetsAt: Math.floor(Date.now() / 1000) + 86400 * 3,
      isUsingOverage: false
    })

    // finish the turn (async so the renderer sees streaming, not a single flush)
    setTimeout(() => {
      this.emit({
        kind: 'turn-complete',
        isError: false,
        result: `turn ${turn} done`,
        costUsd: 0.0123,
        inputTokens: 1200,
        outputTokens: 340,
        // simulate a mostly-full context window (incl. cached tokens) that grows
        contextTokens: 90_000 + turn * 20_000,
        durationMs: 5,
        numTurns: 1
      })
    }, 20)
  }

  interrupt(): void {
    this.emit({ kind: 'turn-complete', isError: false, result: 'interrupted' })
  }

  respondPermission(requestId: string, decision: string): void {
    this.emit({ kind: 'permission-resolved', requestId, decision })
    this.emit({
      kind: 'turn-complete',
      isError: false,
      result: `permission ${decision}`,
      costUsd: 0,
      durationMs: 3
    })
  }

  respondQuestion(requestId: string, answers: QuestionAnswer[]): void {
    this.emit({ kind: 'question-resolved', requestId, answers })
    const picked = answers.flatMap((a) => a.optionIds).join(', ')
    this.emit({
      kind: 'turn-complete',
      isError: false,
      result: `answered: ${picked}`,
      costUsd: 0,
      durationMs: 3
    })
  }

  /**
   * Simulate a real backend rollback (the Codex `thread/rollback` primitive) so
   * the e2e suite can drive the truncate-then-resend flow under
   * HANG4R_FAKE_AGENT. The fake agent holds no conversation state of its own —
   * sessionManager truncates the stored transcript — so acknowledging is enough.
   */
  async rewindTurns(turns: number): Promise<boolean> {
    return turns > 0
  }

  dispose(): void {
    this.listeners = []
  }
}
