import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, PromptImage, QuestionAnswer } from '../../../shared/protocol'
import type { AdapterStartOptions, AgentAdapter, PromptEcho } from './types'
import { enrichClaudeError } from './claudeAdapter'

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
  /** the session id we announce at init — reused so a crafted poison transcript
   *  (see writePoisonTranscript) is named for THIS session */
  private backendSessionId = ''

  onEvent(cb: (ev: AgentEvent) => void): void {
    this.listeners.push(cb)
  }
  private emit(ev: AgentEvent): void {
    for (const cb of this.listeners) cb(ev)
  }

  start(opts: AdapterStartOptions): void {
    this.cwd = opts.cwd
    this.backendSessionId = 'fake-' + randomUUID()
    this.emit({
      kind: 'init',
      backendSessionId: this.backendSessionId,
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

  prompt(text: string, images?: PromptImage[], echo?: PromptEcho): void {
    this.turn += 1
    const turn = this.turn
    // carry images on the user event, exactly like the real adapters — so the
    // chat thumbnail (and its click-to-enlarge lightbox) is exercised in e2e
    this.emit({ kind: 'user-text', text: echo?.displayText ?? text, images, files: echo?.files })

    // deterministic error turn (mirrors Claude's error_during_execution abort)
    // so the suite can prove error recovery: the session goes to error, the
    // wedge-prone adapter is dropped, and the next prompt re-spawns cleanly.
    // Async (like the real turn-complete below) so it lands AFTER prompt()'s
    // caller sets status:'running' — a sync emit would be overwritten.
    // deterministic OPAQUE-interrupt turn: simulate a turn KILLED mid-command by
    // an external driver (session restart / "⇄ interactive CLI"). We drop a
    // POISONED transcript (a dangling tool_use — the residue tailIsPoisoned
    // detects) for THIS session, then report the CLI's opaque error_during_execution
    // with EMPTY stderr — so the classifier yields the generic "The CLI errored"
    // and sessionManager's poison-based relabel is what must produce the friendly
    // "Interrupted mid-command — recovered on next turn" label. Checked BEFORE the
    // 529 trigger below (this phrase doesn't contain "trigger error").
    if (text.includes('trigger opaque interrupt')) {
      this.writePoisonTranscript()
      setTimeout(() => {
        const errEv: Extract<AgentEvent, { kind: 'turn-complete' }> = {
          kind: 'turn-complete',
          isError: true,
          result: 'error_during_execution',
          errorMessage: 'error_during_execution'
        }
        // empty stderr → classifier falls to the generic label; detail still keeps
        // the raw error_during_execution text for the expandable panel
        enrichClaudeError(errEv, '')
        this.emit(errEv)
      }, 20)
      return
    }

    // an Agent call that never gets a result, and THEN the turn dies — the shape
    // an aborted turn really leaves behind, and the only one where "no result"
    // is the honest label
    if (text.includes('abort mid subagent')) {
      const abortMsg = randomUUID()
      this.emit({
        kind: 'block-final',
        messageId: abortMsg,
        blockIndex: 11,
        block: {
          type: 'tool_use',
          id: randomUUID(),
          name: 'Agent',
          input: { description: 'cut short by the abort', subagent_type: 'general-purpose' }
        },
        parentToolUseId: null
      })
      setTimeout(() => {
        this.emit({
          kind: 'turn-complete',
          isError: true,
          result: 'error_during_execution',
          errorMessage: 'error_during_execution'
        })
      }, 40)
      return
    }

    if (text.includes('trigger error')) {
      // mirror a real Claude failure: the opaque error_during_execution on the
      // result, with the REAL reason on stderr — run it through the same
      // enrichment the claude adapter uses so the classified label + expandable
      // detail path is exercised end-to-end
      const stderrTail =
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error",' +
        '"message":"Overloaded"}}'
      this.emit({ kind: 'stderr', text: stderrTail })
      setTimeout(() => {
        const errEv: Extract<AgentEvent, { kind: 'turn-complete' }> = {
          kind: 'turn-complete',
          isError: true,
          result: 'error_during_execution',
          errorMessage: 'error_during_execution'
        }
        enrichClaudeError(errEv, stderrTail)
        this.emit(errEv)
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

    if (text.includes('think about it')) {
      this.emit({
        kind: 'block-final',
        messageId,
        blockIndex: 13,
        block: {
          type: 'thinking',
          thinking: 'Reading the request. A direct edit beats a refactor here.'
        },
        parentToolUseId: null
      })
    }

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

    // an assistant message linking a file OUTSIDE this session's worktree — the
    // shape agents produce constantly, and the one that used to escape to the
    // browser as a raw file:// page
    if (text.includes('link an outside file')) {
      const linkMsg = randomUUID()
      this.emit({
        kind: 'block-final',
        messageId: linkMsg,
        blockIndex: 12,
        block: {
          type: 'text',
          text: `See [lambda.stack.ts:235](file://${this.cwd}/../outside-me.txt) for the detail.`
        },
        parentToolUseId: null
      })
    }

    // a deferred-by-contract tool: returns now, keeps watching, re-invokes later
    if (text.includes('arm a monitor')) {
      const monId = randomUUID()
      this.emit({
        kind: 'block-final',
        messageId,
        blockIndex: 10,
        block: {
          type: 'tool_use',
          id: monId,
          name: 'Monitor',
          input: { command: 'gh pr checks 2567', until: 'all checks settle' }
        },
        parentToolUseId: null
      })
      this.emit({
        kind: 'tool-result',
        toolUseId: monId,
        content: 'Monitor armed. It will report when the condition is met.',
        isError: false,
        parentToolUseId: null
      })
    }

    // the two subagent shapes that OUTLIVE or OUTLAST a turn: an async launch
    // (really still working after the turn ends) and a run whose tool_use never
    // gets a result (an aborted turn leaves it dangling). Both used to read as
    // "running" forever.
    if (text.includes('spawn background agents')) {
      const asyncId = randomUUID()
      this.emit({
        kind: 'block-final',
        messageId,
        blockIndex: 8,
        block: {
          type: 'tool_use',
          id: asyncId,
          name: 'Agent',
          input: { description: 'long haul research', subagent_type: 'general-purpose' }
        },
        parentToolUseId: null
      })
      this.emit({
        kind: 'tool-result',
        toolUseId: asyncId,
        content: `Async agent launched successfully. agentId: bg_${asyncId.slice(0, 12)}`,
        isError: false,
        parentToolUseId: null
      })
      // …and one that never returns: tool_use with no matching tool-result
      this.emit({
        kind: 'block-final',
        messageId,
        blockIndex: 9,
        block: {
          type: 'tool_use',
          id: randomUUID(),
          name: 'Agent',
          input: { description: 'the one that never returns', subagent_type: 'general-purpose' }
        },
        parentToolUseId: null
      })
    }

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
        // summary is a truncated preview; detail carries the FULL command so it's
        // fully readable for the Allow/Deny decision (Angel)
        summary: 'Bash: rm -rf ./sandbox-test && git show 728cb4260 --stat',
        detail:
          'rm -rf ./sandbox-test && git show 728cb4260 --stat FULLCMD_MARKER_qz && echo "the whole command must be readable"',
        options: ['allow', 'allow_session', 'allow_always', 'deny']
      })
      return // turn continues when the user decides (see respondPermission)
    }

    // a tool call that writes a real file so the Diff tab has content
    const toolUseId = randomUUID()
    const filename = `hang4r-fake-${turn}.txt`
    // capture the FULL agent-facing text (not the display echo) so e2e can assert
    // what actually reached the CLI — e.g. the [Attached image saved to: …] note
    const content = `edit from fake agent, turn ${turn}\nprompt was: ${text}\n`
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

  /**
   * E2E only: drop a POISONED Claude transcript (an assistant `tool_use` with no
   * matching `tool_result`) named for THIS session under HANG4R_CLAUDE_PROJECTS_DIR,
   * so ClaudeImport.tailIsPoisoned sees the residue of a turn killed mid-command.
   * No-op unless the e2e root is set (real runs never set it). Written
   * synchronously from prompt() — AFTER sessionManager.prompt's heal-check has
   * already run for this turn (the file didn't exist then), so the heal doesn't
   * pre-empt it and the poison is present when the error turn-complete lands.
   */
  private writePoisonTranscript(): void {
    const root = process.env.HANG4R_CLAUDE_PROJECTS_DIR
    if (!root || !this.backendSessionId) return
    try {
      const dir = join(root, 'e2e-fake-project')
      mkdirSync(dir, { recursive: true })
      const jsonl =
        [
          JSON.stringify({
            type: 'user',
            uuid: 'poison-u0',
            parentUuid: null,
            message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] }
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'poison-a0',
            parentUuid: 'poison-u0',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'poison-tool-dangling', name: 'Bash', input: {} }]
            }
          })
        ].join('\n') + '\n'
      writeFileSync(join(dir, `${this.backendSessionId}.jsonl`), jsonl)
    } catch {
      /* best-effort test seam */
    }
  }

  dispose(): void {
    this.listeners = []
  }
}
