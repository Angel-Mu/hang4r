import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  AgentEvent,
  AgentQuestion,
  ContentBlock,
  PromptImage,
  QuestionAnswer
} from '../../../shared/protocol'
import type { AdapterStartOptions, AgentAdapter } from './types'
import { shellQuote, sshRunArgv } from '../remoteService'

/** appended to the agent's system prompt for local sessions (see start()) */
const BROWSER_CLI_NOTE =
  'This session runs inside the hang4r app, which gives it an embedded browser pane. ' +
  'The `hang4r` CLI is preinstalled on PATH to drive and assert against that browser: ' +
  'run `hang4r browser --help` for the command list (tabs, goto, snapshot, click, type, ' +
  'select, press, scroll, get, eval, wait, screenshot, console). Prefer it over any ' +
  'other browser-automation tool for web tasks in this session; other control CLIs ' +
  "(e.g. cmux) cannot speak hang4r's control socket. " +
  'If `hang4r` is not found on PATH (some login shells rebuild PATH), invoke it by ' +
  'its absolute path from the $HANG4R_CLI env var, e.g. `"$HANG4R_CLI" browser goto <url>`. ' +
  '`hang4r browser goto <url>` opens the browser pane by itself — you do NOT need the ' +
  'user to open it first.'

/**
 * Wraps the user's locally installed, subscription-authenticated `claude` CLI.
 *
 * One persistent process per session:
 *   claude -p --input-format stream-json --output-format stream-json
 *          --verbose --include-partial-messages
 * User turns are written to stdin as NDJSON; events stream back on stdout.
 * Protocol shapes verified empirically against Claude Code v2.1.201.
 *
 * IMPORTANT: we never pass --bare. Anthropic has announced --bare will become
 * the default for -p in a future release; if that lands, hooks/skills/MCP and
 * OAuth would silently vanish. Guard: we pass the full flag set explicitly and
 * pin expectations in tests.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly backend = 'claude' as const

  private proc: ChildProcessWithoutNullStreams | null = null
  private listeners: Array<(ev: AgentEvent) => void> = []
  private stdoutBuf = ''
  /** message id of the in-flight streamed assistant message (from message_start) */
  private currentMessageId: string | null = null
  private currentParent: string | null = null
  private lastContextTokens = 0
  /**
   * Count of blocks already finalized per message id. Real Claude emits one
   * `assistant` event per content block whose content array position is always
   * 0 — the true block index is the finalize order, which must match the
   * stream_event content_block indices or delta and final blocks won't merge.
   */
  private finalizedBlocks = new Map<string, number>()
  private disposed = false
  // spawn/retry state (Claude's binary symlink dangles briefly during auto-update)
  private spawnBinary: string | null = null
  private spawnArgs: string[] | null = null
  private spawnCwd = ''
  private spawnEnv: Record<string, string> | undefined
  private spawnAttempts = 0
  private pending: Array<{ text: string; images?: PromptImage[] }> = []

  onEvent(cb: (ev: AgentEvent) => void): void {
    this.listeners.push(cb)
  }

  private emit(ev: AgentEvent): void {
    for (const cb of this.listeners) cb(ev)
  }

  start(opts: AdapterStartOptions): void {
    // local sessions carry the hang4r browser CLI env (ssh passes none)
    this.spawnEnv = opts.env
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages'
    ]
    if (opts.model) args.push('--model', opts.model)
    if (opts.effort) args.push('--effort', opts.effort)
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId)
      if (opts.fork) args.push('--fork-session')
      // rewind: resume with history truncated at this message uuid (inclusive)
      if (opts.resumeAt) args.push('--resume-session-at', opts.resumeAt)
    }
    if (opts.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    } else {
      args.push('--permission-mode', opts.permissionMode)
      // Interactive approvals: the CLI sends can_use_tool control requests over
      // stdout and we answer on stdin — same mechanism the official SDK uses.
      args.push('--permission-prompt-tool', 'stdio')
    }
    if (opts.env?.HANG4R_CTL_SOCK) {
      // the CLI is on the agent's PATH but agents won't discover it unaided —
      // without this note they reach for other browser tooling that can't
      // speak our control socket. ssh sessions pass no env (the CLI is
      // local-only), so the note is skipped there.
      args.push('--append-system-prompt', BROWSER_CLI_NOTE)
    }

    if (opts.sshHost) {
      // remote session: the CLI runs on the ssh host, in the remote cwd, via a
      // login shell (nvm/homebrew PATH); stream-json + the stdio control
      // protocol flow through ssh's pipes unchanged (docs/ssh-design.md)
      this.spawnArgs = sshRunArgv(
        opts.sshHost,
        opts.cwd,
        'exec ' + ['claude', ...args].map(shellQuote).join(' ')
      )
      this.spawnBinary = 'ssh'
      this.spawnCwd = homedir()
      this.spawnProc()
      return
    }

    if (!existsSync(opts.binaryPath)) {
      this.emit({
        kind: 'turn-complete',
        isError: true,
        errorMessage: `Claude CLI not found at ${opts.binaryPath}. Reinstall Claude Code or set its path in Settings → Models.`
      })
      this.emit({ kind: 'exit', code: -1 })
      return
    }
    this.spawnArgs = args
    this.spawnBinary = opts.binaryPath
    this.spawnCwd = existsSync(opts.cwd) ? opts.cwd : homedir()
    this.spawnProc()
  }

  /**
   * Spawn the CLI. The Claude binary is a symlink that briefly dangles while the
   * CLI auto-updates itself, so a spawn can fail transiently with ENOENT — we
   * retry a few times (buffered prompts flush once it's up) instead of stranding
   * the session.
   */
  private spawnProc(): void {
    if (this.disposed || !this.spawnBinary || !this.spawnArgs) return
    const proc = spawn(this.spawnBinary, this.spawnArgs, {
      cwd: this.spawnCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.spawnEnv }
    })
    this.proc = proc

    proc.on('spawn', () => {
      this.spawnAttempts = 0
      this.flushPending()
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString()
      const lines = this.stdoutBuf.split('\n')
      this.stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        this.handleLine(line)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      this.emit({ kind: 'stderr', text: chunk.toString() })
    })

    proc.on('exit', (code) => {
      if (!this.disposed) this.emit({ kind: 'exit', code })
      this.proc = null
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      this.proc = null
      if (err.code === 'ENOENT' && this.spawnAttempts < 4 && !this.disposed) {
        // likely mid-auto-update; back off and retry, keeping buffered prompts
        this.spawnAttempts++
        setTimeout(() => this.spawnProc(), 600 * this.spawnAttempts)
        return
      }
      this.emit({ kind: 'turn-complete', isError: true, errorMessage: String(err) })
      this.emit({ kind: 'exit', code: -1 })
    })
  }

  /** flush any prompts queued while the process was (re)spawning */
  private flushPending(): void {
    if (!this.proc?.stdin.writable) return
    const queued = this.pending.splice(0)
    for (const p of queued) this.writePrompt(p.text, p.images)
  }

  private writePrompt(text: string, images?: PromptImage[]): void {
    const content: unknown[] = []
    for (const img of images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
      })
    }
    content.push({ type: 'text', text })
    this.proc?.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
  }

  prompt(text: string, images?: PromptImage[]): void {
    // buffer during the (re)spawn window so an auto-update blip doesn't drop it
    if (this.spawnAttempts > 0 || (!this.proc && this.spawnBinary)) {
      this.emit({ kind: 'user-text', text, images })
      this.pending.push({ text, images })
      return
    }
    if (!this.proc?.stdin.writable) {
      this.emit({
        kind: 'turn-complete',
        isError: true,
        errorMessage: 'Agent process is not running'
      })
      return
    }
    this.emit({ kind: 'user-text', text, images })
    this.writePrompt(text, images)
  }

  interrupt(): void {
    if (!this.proc?.stdin.writable) return
    // remember that WE asked — the CLI reports an interrupted turn as a generic
    // error_during_execution, indistinguishable from a real failure by message;
    // the emit path relabels the next error turn-complete as 'interrupted' so
    // the UI doesn't paint a user-initiated stop as an error (QA follow-up)
    this.interruptRequested = true
    // Control protocol interrupt; if the CLI ignores it the turn keeps running
    this.proc.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'interrupt' }
      }) + '\n'
    )
  }

  dispose(): void {
    this.disposed = true
    if (this.proc) {
      this.proc.stdin.end()
      const p = this.proc
      // grace period, then hard kill
      setTimeout(() => {
        if (!p.killed) p.kill('SIGKILL')
      }, 3000)
      p.kill()
      this.proc = null
    }
  }

  private handleLine(line: string): void {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line)
    } catch {
      this.emit({ kind: 'stderr', text: `unparseable output line: ${line.slice(0, 200)}` })
      return
    }
    if (raw.type === 'control_request') {
      this.handleControlRequest(raw as unknown as ClaudeControlRequest)
      return
    }
    if (raw.type === 'control_response' || raw.type === 'keep_alive') return
    for (const ev of translateClaudeEvent(raw, this)) {
      // relabel a turn we interrupted ourselves — see interrupt()
      if (ev.kind === 'turn-complete') {
        if (this.interruptRequested && ev.isError) ev.errorMessage = 'interrupted'
        this.interruptRequested = false
      }
      this.emit(ev)
    }
  }

  /** set when interrupt() was sent; the next error turn-complete is relabeled */
  private interruptRequested = false

  /** pending can_use_tool requests: our requestId -> original request */
  private pendingApprovals = new Map<string, ClaudeControlRequest>()
  /** pending AskUserQuestion requests: our requestId -> original request */
  private pendingQuestions = new Map<string, ClaudeControlRequest>()

  private handleControlRequest(req: ClaudeControlRequest): void {
    if (req.request.subtype === 'can_use_tool') {
      const r = req.request
      // AskUserQuestion is an interactive multiple-choice question, NOT a tool
      // approval — it arrives as a can_use_tool with requires_user_interaction
      // and input.questions[]. Surface it as an answerable question card (the
      // user picks an option), not a generic Allow/Deny permission. Verified
      // live against Claude Code v2.1.207 (scratch: claude-raw.ndjson).
      const questions = askUserQuestions(r)
      if (questions) {
        this.pendingQuestions.set(req.request_id, req)
        this.emit({ kind: 'question-request', requestId: req.request_id, questions })
        return
      }
      this.pendingApprovals.set(req.request_id, req)
      // when the CLI proposes persistable rules, offer session/always variants
      const options = r.permission_suggestions?.length
        ? ['allow', 'allow_session', 'allow_always', 'deny']
        : ['allow', 'deny']
      this.emit({
        kind: 'permission-request',
        requestId: req.request_id,
        tool: r.tool_name ?? 'tool',
        summary: summarizeToolInput(r.tool_name, r.input) || (r.title ?? r.tool_name ?? 'Use tool'),
        detail: r.description,
        options,
        toolUseId: r.tool_use_id
      })
      return
    }
    // any other control request we can't service: answer with an error so the
    // CLI doesn't hang waiting on us
    this.writeLine({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: req.request_id,
        error: `unsupported control request: ${req.request.subtype}`
      }
    })
  }

  respondPermission(requestId: string, decision: string): void {
    const req = this.pendingApprovals.get(requestId)
    if (!req) return
    this.pendingApprovals.delete(requestId)
    const suggestions = req.request.permission_suggestions ?? []
    const result =
      decision === 'allow_always' && suggestions.length
        ? // persist the CLI's own proposed rules (its chosen settings file) —
          // this tool call never asks again, in ANY session
          { behavior: 'allow', updatedInput: req.request.input, updatedPermissions: suggestions }
        : decision === 'allow_session' && suggestions.length
          ? // same rules, but scoped to this session only
            {
              behavior: 'allow',
              updatedInput: req.request.input,
              updatedPermissions: suggestions.map((s) => ({ ...s, destination: 'session' }))
            }
          : decision === 'allow' || decision === 'allow_session' || decision === 'allow_always'
            ? { behavior: 'allow', updatedInput: req.request.input }
            : { behavior: 'deny', message: 'User denied this action in hang4r.' }
    this.writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: result }
    })
    this.emit({ kind: 'permission-resolved', requestId, decision })
  }

  respondQuestion(requestId: string, answers: QuestionAnswer[]): void {
    const req = this.pendingQuestions.get(requestId)
    if (!req) return
    this.pendingQuestions.delete(requestId)
    // AskUserQuestion is answered by ALLOWING the can_use_tool with the ORIGINAL
    // input.questions left intact (they must still satisfy the tool schema —
    // mutating options fails validation, verified live) PLUS an `answers` map of
    // question text -> selected label(s). Single-select → a string, multi-select
    // → an array. Source: code.claude.com/docs/en/agent-sdk/user-input.md.
    const rawQuestions = (req.request.input?.questions ?? []) as ClaudeQuestion[]
    const answerMap: Record<string, string | string[]> = {}
    for (const a of answers) {
      const q = rawQuestions[Number(a.questionId)]
      if (!q) continue
      // option ids ARE the labels (set in askUserQuestions) — send labels back
      answerMap[q.question] = q.multiSelect ? a.optionIds : (a.optionIds[0] ?? '')
    }
    this.writeLine({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: { ...req.request.input, questions: rawQuestions, answers: answerMap }
        }
      }
    })
    this.emit({ kind: 'question-resolved', requestId, answers })
  }

  private writeLine(msg: Record<string, unknown>): void {
    if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  setModel(model: string): void {
    // SDK control protocol: set_model switches the main-loop model mid-session
    this.writeLine({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'set_model', model }
    })
  }

  /* translation state accessors (used by translateClaudeEvent) */
  _getMessageId(): string | null {
    return this.currentMessageId
  }
  _setMessageId(id: string | null): void {
    this.currentMessageId = id
  }
  _getParent(): string | null {
    return this.currentParent
  }
  _setParent(p: string | null): void {
    this.currentParent = p
  }
  _nextFinalIndex(messageId: string): number {
    const n = this.finalizedBlocks.get(messageId) ?? 0
    this.finalizedBlocks.set(messageId, n + 1)
    return n
  }
  _getContextTokens(): number {
    return this.lastContextTokens
  }
  _setContextTokens(n: number): void {
    this.lastContextTokens = n
  }
}

interface TranslationState {
  _getMessageId(): string | null
  _setMessageId(id: string | null): void
  _getParent(): string | null
  _setParent(p: string | null): void
  _nextFinalIndex(messageId: string): number
  _getContextTokens(): number
  _setContextTokens(n: number): void
}

/**
 * Pure translation of one Claude stream-json line into zero or more AgentEvents.
 * Exported for fixture-based testing.
 */
export function translateClaudeEvent(
  raw: Record<string, unknown>,
  state: TranslationState
): AgentEvent[] {
  const type = raw.type as string

  if (type === 'system') {
    const subtype = raw.subtype as string
    if (subtype === 'init') {
      return [
        {
          kind: 'init',
          backendSessionId: raw.session_id as string,
          model: raw.model as string,
          tools: (raw.tools as string[]) ?? [],
          mcpServers: (raw.mcp_servers as { name: string; status: string }[]) ?? [],
          skills: (raw.skills as string[]) ?? [],
          slashCommands: (raw.slash_commands as string[]) ?? [],
          plugins: (raw.plugins as { name: string }[]) ?? [],
          permissionMode: raw.permissionMode as string,
          version: raw.claude_code_version as string
        }
      ]
    }
    if (subtype === 'hook_started' || subtype === 'hook_response') {
      return [
        {
          kind: 'hook',
          phase: subtype === 'hook_started' ? 'started' : 'response',
          hookName: raw.hook_name as string,
          hookEvent: raw.hook_event as string,
          outcome: raw.outcome as string | undefined
        }
      ]
    }
    return [] // thinking_tokens, status, etc — not rendered individually
  }

  if (type === 'stream_event') {
    const parent = (raw.parent_tool_use_id as string | null) ?? null
    const ev = raw.event as Record<string, unknown>
    const evType = ev.type as string

    if (evType === 'message_start') {
      const msg = ev.message as Record<string, unknown>
      state._setMessageId(msg.id as string)
      state._setParent(parent)
      // the assistant message's input usage IS the context size for this turn —
      // emit it live so the per-session gauge fills in while the agent works
      const u = (msg.usage as Record<string, unknown>) ?? {}
      const num = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
      const ctx =
        num('input_tokens') + num('cache_read_input_tokens') + num('cache_creation_input_tokens')
      if (ctx > 0) {
        state._setContextTokens(ctx)
        return [{ kind: 'usage', contextTokens: ctx, inputTokens: num('input_tokens') }]
      }
      return []
    }
    const messageId = state._getMessageId()
    if (!messageId) return []

    if (evType === 'content_block_start') {
      const block = ev.content_block as Record<string, unknown>
      return [
        {
          kind: 'block-start',
          messageId,
          blockIndex: ev.index as number,
          blockType: block.type as ContentBlock['type'],
          toolName: block.type === 'tool_use' ? (block.name as string) : undefined,
          parentToolUseId: parent
        }
      ]
    }
    if (evType === 'content_block_delta') {
      const delta = ev.delta as Record<string, unknown>
      const text =
        (delta.text as string) ?? (delta.thinking as string) ?? (delta.partial_json as string)
      if (typeof text !== 'string') return []
      return [
        {
          kind: 'block-delta',
          messageId,
          blockIndex: ev.index as number,
          text,
          parentToolUseId: parent
        }
      ]
    }
    return []
  }

  if (type === 'assistant') {
    // Authoritative snapshot: real Claude emits one assistant event per content
    // block. The block's position in THIS event's array is meaningless (always
    // 0) — the true index is the finalize order per message, which lines up
    // with the stream_event content_block indices so deltas and finals merge.
    const parent = (raw.parent_tool_use_id as string | null) ?? null
    const msg = raw.message as Record<string, unknown>
    const content = (msg.content as Record<string, unknown>[]) ?? []
    return content.map((block) => ({
      kind: 'block-final' as const,
      messageId: msg.id as string,
      blockIndex: state._nextFinalIndex(msg.id as string),
      block: normalizeBlock(block),
      parentToolUseId: parent
    }))
  }

  if (type === 'user') {
    // tool results come back as user messages
    const parent = (raw.parent_tool_use_id as string | null) ?? null
    const msg = raw.message as Record<string, unknown>
    const content = msg.content
    if (!Array.isArray(content)) return []
    const out: AgentEvent[] = []
    let injectedText = ''
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'tool_result') {
        out.push({
          kind: 'tool-result',
          toolUseId: block.tool_use_id as string,
          content: block.content,
          isError: (block.is_error as boolean) ?? false,
          parentToolUseId: parent
        })
      } else if (block.type === 'text' && typeof block.text === 'string') {
        injectedText += block.text + '\n'
      }
    }
    // harness-injected user messages (NOT typed by the user — we echo real
    // prompts ourselves): background task/agent completion notifications land
    // here. Surface them as subagent-notes so the Subagents threads can flip
    // 'running in background' → done with the real result.
    if (
      !parent &&
      injectedText &&
      /task[-_ ]?notification|agent[-_ ]?id|background (task|agent)|completed|finished/i.test(
        injectedText
      )
    ) {
      out.push({ kind: 'subagent-note', text: injectedText.trim() })
    }
    return out
  }

  if (type === 'rate_limit_event') {
    const info = raw.rate_limit_info as Record<string, unknown>
    return [
      {
        kind: 'rate-limit',
        rateLimitType: info.rateLimitType as string,
        status: info.status as string,
        resetsAt: info.resetsAt as number,
        isUsingOverage: (info.isUsingOverage as boolean) ?? false
      }
    ]
  }

  if (type === 'result') {
    const usage = (raw.usage as Record<string, unknown>) ?? {}
    const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
    // The result event's usage is SUMMED across every API call in the turn, so
    // input + cache tokens overstate context occupancy by the number of steps
    // (a 30-tool-call turn reports ~30× the window and pins the gauge at 100%).
    // The last message_start's usage is the true occupancy — prefer it, and
    // only fall back to the summed figure when nothing streamed (0-step turns).
    const summed =
      n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens')
    const contextTokens = state._getContextTokens() || summed
    return [
      {
        kind: 'turn-complete',
        isError: (raw.is_error as boolean) ?? false,
        result: raw.result as string | undefined,
        errorMessage: raw.is_error ? ((raw.result as string) ?? raw.subtype) as string : undefined,
        costUsd: raw.total_cost_usd as number | undefined,
        inputTokens: usage.input_tokens as number | undefined,
        outputTokens: usage.output_tokens as number | undefined,
        contextTokens: contextTokens || undefined,
        numTurns: raw.num_turns as number | undefined,
        durationMs: raw.duration_ms as number | undefined,
        permissionDenials: raw.permission_denials as unknown[] | undefined
      }
    ]
  }

  return []
}

/** One AskUserQuestion question as it arrives inside a can_use_tool input. */
interface ClaudeQuestion {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

interface ClaudeControlRequest {
  type: 'control_request'
  request_id: string
  request: {
    subtype: string
    tool_name?: string
    input?: Record<string, unknown> & { questions?: ClaudeQuestion[] }
    title?: string
    description?: string
    tool_use_id?: string
    agent_id?: string
    /** true for interactive tools (AskUserQuestion) that need a user answer */
    requires_user_interaction?: boolean
    /** persistable allow-rules the CLI proposes (addRules + destination) */
    permission_suggestions?: Array<Record<string, unknown>>
  }
}

/**
 * If this can_use_tool request is an AskUserQuestion (interactive multiple
 * choice), translate its questions into our protocol shape; otherwise null (a
 * normal tool approval). Detects on tool_name AND a well-formed questions array
 * so a future rename of the tool still routes correctly. Each option's id IS
 * its label — AskUserQuestion answers are keyed by label (see respondQuestion).
 */
export function askUserQuestions(
  r: ClaudeControlRequest['request']
): AgentQuestion[] | null {
  const questions = r.input?.questions
  const looksLikeQuestion =
    r.tool_name === 'AskUserQuestion' || r.requires_user_interaction === true
  if (!looksLikeQuestion || !Array.isArray(questions) || questions.length === 0) return null
  const mapped: AgentQuestion[] = []
  questions.forEach((q, i) => {
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) return
    mapped.push({
      id: String(i),
      prompt: q.header ? `${q.header}: ${q.question}` : q.question,
      options: q.options
        .filter((o) => o && typeof o.label === 'string')
        .map((o) => ({ id: o.label, label: o.label })),
      allowMultiple: !!q.multiSelect
    })
  })
  return mapped.length ? mapped : null
}

function summarizeToolInput(tool: string | undefined, input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    const hint = o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern ?? o.query
    if (typeof hint === 'string') {
      return `${tool ?? 'tool'}: ${hint.length > 90 ? hint.slice(0, 87) + '…' : hint}`
    }
  }
  return ''
}

function normalizeBlock(block: Record<string, unknown>): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text as string }
  if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking as string }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id as string,
      name: block.name as string,
      input: block.input
    }
  }
  // unknown block types degrade to text so nothing is silently dropped
  return { type: 'text', text: JSON.stringify(block) }
}
