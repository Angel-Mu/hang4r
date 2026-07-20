import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AgentEvent, PromptImage } from '../../../shared/protocol'
import type { AdapterStartOptions, AgentAdapter } from './types'

/**
 * Wraps the user's locally installed, subscription-authenticated `cursor-agent`
 * CLI (Cursor's headless coding agent).
 *
 * Unlike Claude/Codex, cursor-agent has no long-lived stdin protocol in
 * headless (`-p`) mode: the prompt is passed as the LAST argv and the process
 * runs ONE turn, then exits. So this adapter spawns a fresh child per turn and
 * threads conversation continuity with `--resume <chatId>` (the session_id from
 * the first turn's init). Protocol shapes verified live — docs/cursor-agent-protocol.md.
 *
 * Spawn line:
 *   cursor-agent -p --trust --output-format stream-json --stream-partial-output
 *                [--model m] [--mode plan] [--force --approve-mcps] [--resume id] "<prompt>"
 *
 * Permissions are FLAG-ONLY: there is no interactive approval channel in -p
 * mode. A non-allowlisted command is auto-rejected in-stream and the model
 * works around it; we render those rejections as blocked tool rows (no Allow
 * button — there is nothing to answer). `--force` (bypass) lets everything run.
 */
/**
 * Decide what a `prompt()` should do given the child's state — the core of the
 * Cursor queue-race fix. cursor-agent spawns one child per turn and emits its
 * `result` line (→ turn-complete → renderer flushes the queue) BEFORE the child
 * actually exits. A prompt landing in that result→exit gap must NOT be rejected
 * as "still working": the turn is genuinely finished.
 *
 *   - no child alive            → 'spawn'  (start the turn immediately)
 *   - child alive, result seen  → 'buffer' (draining after finish — hold, spawn on exit)
 *   - child alive, no result    → 'reject' (a real concurrent turn is in flight)
 *
 * Pure and exported so the state machine is unit-tested without spawning a CLI.
 */
export function resolvePromptAction(
  procAlive: boolean,
  sawResult: boolean
): 'spawn' | 'buffer' | 'reject' {
  if (!procAlive) return 'spawn'
  return sawResult ? 'buffer' : 'reject'
}

/**
 * SIGTERM/SIGKILL the WHOLE process group cursor-agent was spawned into
 * (negative pid — POSIX only, fine on this darwin-targeted app). Fixes round
 * 13/14 QA: cursor-agent spawns long-running shell tools as descendants, and
 * killing only the cursor-agent pid orphaned them. Spawning with
 * `detached: true` makes cursor-agent its own group leader (pgid === pid), so
 * `-pid` reaches it and every descendant. try/catch: the group (or process)
 * may already be gone (ESRCH) by the time this runs — that's a no-op, not a bug.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // already dead — nothing to kill
  }
}

/**
 * What the child's `exit` handler should do, given the turn's end state. Pure +
 * exported so the exit state machine — including the interrupt-with-buffer path
 * — is unit-tested without spawning a CLI.
 *
 *   synthInterrupted: emit a turn-complete so the UI unsticks — only when the
 *     turn ended WITHOUT a `result` (crash / non-zero exit / a kill from Stop)
 *     and we aren't tearing the adapter down.
 *   spawnPending: launch a buffered follow-up (the queue drain-gap fix) — only
 *     when one is still held and we aren't tearing down. A Stop kills the child
 *     mid-turn (no result) → synthInterrupted; it leaves the buffer intact, so a
 *     genuinely-buffered follow-up still spawns from exit (drain-gap design).
 */
export function resolveExitAction(
  sawResult: boolean,
  disposed: boolean,
  hasPending: boolean
): { synthInterrupted: boolean; spawnPending: boolean } {
  return {
    synthInterrupted: !sawResult && !disposed,
    spawnPending: hasPending && !disposed
  }
}

/**
 * Should the drain-gap watchdog escalate to a hard kill? The watchdog fires
 * once, 5s after a prompt was buffered (turn finished, child still draining —
 * see resolvePromptAction's 'buffer' outcome). It only escalates if the
 * buffered prompt is still waiting AND the child genuinely hasn't exited yet;
 * both can go stale by the time the timer fires (natural exit clears the
 * timer, but this stays correct even if a race let it run anyway).
 */
export function shouldEscalateDrain(pendingStillHeld: boolean, childHasExited: boolean): boolean {
  return pendingStillHeld && !childHasExited
}

export class CursorAdapter implements AgentAdapter {
  readonly backend = 'cursor' as const

  private listeners: Array<(ev: AgentEvent) => void> = []
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  private opts: AdapterStartOptions | null = null
  /** chatId to --resume: seeded from an imported session, then the init session_id */
  private resumeId: string | null = null
  private disposed = false
  /** did the in-flight turn's process emit a `result`? drives interrupt/crash handling */
  private sawResult = false
  /** a prompt that arrived during the result→exit drain gap (turn finished, child
   *  still draining) — held in a single slot and spawned from the exit handler.
   *  See resolvePromptAction: this is the 'buffer' outcome, the queue-race fix.
   *  Only `text` is needed to re-spawn: cursor-agent -p can't ingest images, so
   *  they ride only in the `user-text` echo (already emitted when buffered). */
  private pending: { text: string } | null = null
  /** drain-gap watchdog: armed when a prompt is buffered, cleared on natural
   *  exit. See shouldEscalateDrain — fires once, SIGKILLs the group if the
   *  draining child still hasn't exited after the grace period. */
  private drainTimer: NodeJS.Timeout | null = null
  /** last meaningful stderr line — the real reason when a turn dies without a result
   *  (e.g. "ActionRequiredError: You've hit your usage limit ...") */
  private lastStderr = ''
  private state = new CursorState()

  onEvent(cb: (ev: AgentEvent) => void): void {
    this.listeners.push(cb)
  }
  private emit(ev: AgentEvent): void {
    for (const cb of this.listeners) cb(ev)
  }

  start(opts: AdapterStartOptions): void {
    this.opts = opts
    this.resumeId = opts.resumeSessionId ?? null
    // no process yet: cursor-agent needs the prompt as argv, so the first child
    // is spawned on the first prompt() (which also yields the init event).
  }

  prompt(text: string, images?: PromptImage[]): void {
    const opts = this.opts
    if (!opts) return

    // Decide the outcome BEFORE echoing anything. `user-text` means "this was
    // sent" — echoing it ahead of a reject/error paints a message as sent when
    // it never reached a child process, then immediately contradicts itself
    // with an error card (round 13/14 QA: "looks sent but isn't"). Only the
    // 'spawn' and 'buffer' outcomes genuinely dispatch the prompt, so only
    // those echo.
    if (!existsSync(opts.binaryPath)) {
      // never reaches a process at all — error card alone is the honest
      // transcript; applyEvent() renders turn-complete as its own item
      // regardless of a preceding user-text, so nothing is lost by skipping it
      this.emit({
        kind: 'turn-complete',
        isError: true,
        errorMessage: `Cursor CLI not found at ${opts.binaryPath}. Install cursor-agent and log in (cursor-agent login), or set its path in Settings → Models.`
      })
      return
    }
    const action = resolvePromptAction(!!this.proc, this.sawResult)
    if (action === 'reject') {
      // a turn is GENUINELY in flight (process alive, no result yet) —
      // cursor-agent can't take a second concurrent prompt; surface it rather
      // than silently dropping the message. No echo: it was dropped, not sent.
      this.emit({
        kind: 'turn-complete',
        isError: true,
        errorMessage: 'Cursor is still working on the previous turn.'
      })
      return
    }
    if (action === 'buffer') {
      // the turn is FINISHED (result seen) but its child is still draining to
      // exit. The renderer flushes the queue on turn-complete, which lands here
      // in that gap — hold the prompt and spawn it from the exit handler instead
      // of falsely erroring. This is the fix for the Cursor queue race.
      if (this.pending) {
        // upstream queue discipline sends one message per idle transition, so a
        // second buffered prompt shouldn't occur — keep the first, reject this
        // one. No echo: this one was dropped, not queued.
        this.emit({ kind: 'stderr', text: 'cursor: a prompt was already buffered during turn drain' })
        this.emit({
          kind: 'turn-complete',
          isError: true,
          errorMessage: 'Cursor is still working on the previous turn.'
        })
        return
      }
      // genuinely will be sent once the child exits — echo now, it's honest
      this.emit({ kind: 'user-text', text, images })
      this.pending = { text }
      this.armDrainWatchdog()
      return
    }
    // action === 'spawn' — no child, start the turn now
    this.emit({ kind: 'user-text', text, images })
    this.spawnTurn(text)
  }

  /** Drain-gap watchdog (round 8 follow-up ③): if the draining child hasn't
   *  exited 5s after a prompt was buffered, escalate — SIGKILL its process
   *  group so `exit` fires and the buffered prompt spawns instead of waiting
   *  forever. Cleared on natural exit (see spawnTurn's exit handler). */
  private armDrainWatchdog(): void {
    const p = this.proc
    if (!p || p.pid == null) return
    const pid = p.pid
    this.clearDrainWatchdog()
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      const childHasExited = p.exitCode !== null || p.signalCode !== null
      if (shouldEscalateDrain(this.pending !== null, childHasExited)) {
        killProcessGroup(pid, 'SIGKILL')
      }
    }, 5000)
  }

  private clearDrainWatchdog(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
  }

  /** Spawn a fresh cursor-agent child for one turn. Assumes no live child
   *  (`prompt()` gates this via resolvePromptAction). Does NOT emit `user-text` —
   *  the caller (prompt or the exit-handler drain) already echoed it. */
  private spawnTurn(text: string): void {
    const opts = this.opts
    if (!opts) return

    const args = [
      '-p',
      '--trust',
      '--output-format',
      'stream-json',
      '--stream-partial-output'
    ]
    const model = opts.model?.trim()
    if (model && model !== 'auto') args.push('--model', model)
    if (opts.permissionMode === 'plan') {
      args.push('--mode', 'plan')
    } else if (opts.permissionMode === 'bypassPermissions') {
      args.push('--force', '--approve-mcps')
    }
    if (this.resumeId) args.push('--resume', this.resumeId)
    args.push(text) // prompt is the LAST argv (spawn passes argv directly — no shell quoting)

    const cwd = existsSync(opts.cwd) ? opts.cwd : homedir()
    this.state = new CursorState()
    this.sawResult = false
    this.lastStderr = ''
    const proc = spawn(opts.binaryPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // local sessions carry the hang4r browser CLI env (ssh passes none)
      env: { ...process.env, ...opts.env },
      // own process group (pgid === pid) so interrupt()/dispose()/the drain
      // watchdog can kill cursor-agent's spawned tool subprocesses too, not
      // just cursor-agent itself. NOT unref()'d — we still need `exit` to fire.
      detached: true
    })
    this.proc = proc

    proc.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString()
      const lines = this.stdoutBuf.split('\n')
      this.stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) this.handleLine(line)
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length) this.lastStderr = lines[lines.length - 1]
      this.emit({ kind: 'stderr', text })
    })
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null
      this.clearDrainWatchdog()
      // flush any partial buffered line
      if (this.stdoutBuf.trim()) {
        this.handleLine(this.stdoutBuf)
        this.stdoutBuf = ''
      }
      const { synthInterrupted, spawnPending } = resolveExitAction(
        this.sawResult,
        this.disposed,
        this.pending !== null
      )
      // the turn ended without a `result` (crash, non-zero exit, or a Stop that
      // killed the child) — synthesize a turn-complete so the UI unsticks
      if (synthInterrupted) {
        // prefer the CLI's own stderr reason over a bare exit code — e.g. a
        // usage-limit refusal is "ActionRequiredError: You've hit your usage
        // limit ...", which is what the user needs to see on the error card.
        // A signal kill (SIGTERM/SIGKILL from Stop) reports code === null → we
        // settle it as a plain 'interrupted', not an error.
        const reason = this.lastStderr.replace(/^ActionRequiredError:\s*/, '')
        this.emit({
          kind: 'turn-complete',
          isError: true,
          errorMessage:
            code === 0 || code === null
              ? 'interrupted'
              : reason || `cursor-agent exited (code ${code})`
        })
      }
      // a prompt buffered during the drain gap (queue-race fix): the child is
      // gone now, so spawn its turn. Its `user-text` was already echoed when it
      // was buffered, so spawnTurn only re-runs the CLI.
      if (spawnPending && this.pending) {
        const next = this.pending
        this.pending = null
        this.spawnTurn(next.text)
      }
    })
    proc.on('error', (err) => {
      if (this.proc === proc) this.proc = null
      this.emit({ kind: 'turn-complete', isError: true, errorMessage: String(err) })
    })
  }

  interrupt(): void {
    // cursor-agent has no in-band interrupt in headless (-p) mode, so Stop can
    // only kill the child. A bare SIGTERM was the bug behind "I can't stop a
    // Cursor agent": cursor-agent can ignore or be slow on SIGTERM, so the
    // process (and the turn) never ended and the exit handler never fired.
    // Escalate to SIGKILL after a grace period, mirroring dispose(); the exit
    // handler then emits turn-complete('interrupted') (no result arrived) so the
    // UI settles. A buffered follow-up (if any) is left untouched and still
    // spawns from the exit handler — unchanged from the drain-gap design. (That
    // state is unreachable from the UI anyway: the buffer exists only in the
    // post-result gap, where status is already idle and no Stop button shows.)
    //
    // Kills the whole PROCESS GROUP, not just cursor-agent's own pid — it
    // spawns long-running shell tools as descendants (detached: true in
    // spawnTurn makes it their group leader), and a plain `p.kill()` orphaned
    // them (round 13/14 QA).
    const p = this.proc
    if (!p || p.pid == null) return
    const pid = p.pid
    killProcessGroup(pid, 'SIGTERM')
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) killProcessGroup(pid, 'SIGKILL')
    }, 2000)
  }

  setModel(model: string): void {
    // applied on the next spawned turn
    if (this.opts) this.opts.model = model
  }

  dispose(): void {
    this.disposed = true
    this.pending = null
    this.clearDrainWatchdog()
    const p = this.proc
    if (p && p.pid != null) {
      const pid = p.pid
      killProcessGroup(pid, 'SIGTERM')
      setTimeout(() => {
        if (p.exitCode === null && p.signalCode === null) killProcessGroup(pid, 'SIGKILL')
      }, 2000)
      this.proc = null
    }
  }

  private handleLine(line: string): void {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line)
    } catch {
      this.emit({ kind: 'stderr', text: `unparseable cursor line: ${line.slice(0, 200)}` })
      return
    }
    if (raw.type === 'result') this.sawResult = true
    for (const ev of translateCursorEvent(raw, this.state)) {
      // capture the session_id so subsequent turns resume this conversation
      if (ev.kind === 'init' && ev.backendSessionId) this.resumeId = ev.backendSessionId
      this.emit(ev)
    }
  }
}

/**
 * Per-turn translation state. cursor-agent streams text/thinking as repeated
 * chunk messages with no stable ids, so we synthesize a fresh messageId per
 * contiguous run ("segment") and finalize it when the run ends — matching how
 * the renderer merges block-delta into block-final on messageId+blockIndex.
 */
export class CursorState {
  private seq = 0
  textId: string | null = null
  textAcc = ''
  thinkId: string | null = null
  thinkAcc = ''
  /** args seen on a tool_call `started`, kept so a later `completed` (which may
   *  omit them) can still describe a blocked question by its call_id */
  toolArgs = new Map<string, unknown>()

  next(prefix: string): string {
    return `cursor-${prefix}-${this.seq++}`
  }
}

/**
 * Pure translation of one cursor-agent stream-json line into zero or more
 * AgentEvents. Exported for fixture-based testing.
 */
export function translateCursorEvent(
  raw: Record<string, unknown>,
  state: CursorState
): AgentEvent[] {
  const type = raw.type as string

  if (type === 'system') {
    if (raw.subtype === 'init') {
      return [
        {
          kind: 'init',
          backendSessionId: (raw.session_id as string) ?? '',
          model: (raw.model as string) || 'cursor-default',
          tools: [],
          mcpServers: [],
          skills: [],
          slashCommands: [],
          plugins: [],
          permissionMode: (raw.permissionMode as string) ?? 'default',
          version: 'cursor-agent'
        }
      ]
    }
    return []
  }

  // prompt echo — we emit user-text ourselves in prompt(), so drop it here
  if (type === 'user') return []

  if (type === 'thinking') {
    const subtype = raw.subtype as string
    if (subtype === 'delta') {
      const text = raw.text as string
      if (typeof text !== 'string' || !text) return []
      const out = closeText(state) // a new thinking run ends any open text run
      if (!state.thinkId) state.thinkId = state.next('think')
      state.thinkAcc += text
      out.push({
        kind: 'block-delta',
        messageId: state.thinkId,
        blockIndex: 0,
        text,
        parentToolUseId: null
      })
      return out
    }
    if (subtype === 'completed') return closeThinking(state)
    return []
  }

  if (type === 'assistant') {
    const text = assistantText(raw)
    if (!text) return []
    const out = closeThinking(state) // text resumes after a thinking run
    // cursor repeats the FULL segment text as a final chunk — when a chunk
    // equals everything accumulated so far, it's that repeat: finalize, drop it
    if (text === state.textAcc && state.textAcc) {
      return out.concat(closeText(state))
    }
    if (!state.textId) state.textId = state.next('text')
    state.textAcc += text
    out.push({
      kind: 'block-delta',
      messageId: state.textId,
      blockIndex: 0,
      text,
      parentToolUseId: null
    })
    return out
  }

  if (type === 'tool_call') {
    const out = closeThinking(state)
    out.push(...closeText(state))
    const callId = (raw.call_id as string) ?? 'cursor-tool'
    const { name, args, result } = extractToolCall(raw)
    if (raw.subtype === 'started') {
      if (args !== undefined) state.toolArgs.set(callId, args)
      out.push({
        kind: 'block-final',
        messageId: `cursor-tool-${callId}`,
        blockIndex: 0,
        block: { type: 'tool_use', id: callId, name, input: args },
        parentToolUseId: null
      })
    } else if (raw.subtype === 'completed') {
      const rejected = result && typeof result === 'object' && 'rejected' in result
      let content: unknown = rejected ? "Blocked by Cursor's policy" : (result ?? null)
      if (rejected) {
        // cursor-agent's headless (-p) mode has NO interactive question channel:
        // when the model tries to ASK the user (an ask/question/elicit tool), the
        // request is auto-rejected upstream and we can't answer it. Rather than a
        // bare "Blocked by Cursor's policy", surface WHAT it wanted to ask — the
        // one honest thing we can do here (we still cannot answer it).
        const rejectedPayload = (result as { rejected?: unknown }).rejected
        // the question data may ride on the completed args, the started args
        // (stashed by call_id — completed often omits them), or the rejected
        // payload; hand all three to the describer, best source wins.
        const question = describeBlockedQuestion(
          name,
          args,
          state.toolArgs.get(callId),
          rejectedPayload
        )
        if (question) content = question
      }
      out.push({
        kind: 'tool-result',
        toolUseId: callId,
        content,
        isError: !!rejected,
        parentToolUseId: null
      })
    }
    return out
  }

  if (type === 'result') {
    const out = closeThinking(state)
    out.push(...closeText(state))
    const usage = (raw.usage as Record<string, unknown>) ?? {}
    const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
    const contextTokens = n('inputTokens') + n('cacheReadTokens') + n('cacheWriteTokens')
    const isError = (raw.is_error as boolean) ?? false
    out.push({
      kind: 'turn-complete',
      isError,
      result: raw.result as string | undefined,
      errorMessage: isError ? ((raw.result as string) ?? 'cursor turn failed') : undefined,
      inputTokens: n('inputTokens') || undefined,
      outputTokens: n('outputTokens') || undefined,
      contextTokens: contextTokens || undefined
    })
    return out
  }

  return []
}

/** Finalize the open thinking run (if any), emitting its authoritative block. */
function closeThinking(state: CursorState): AgentEvent[] {
  if (!state.thinkId) return []
  const id = state.thinkId
  const thinking = state.thinkAcc
  state.thinkId = null
  state.thinkAcc = ''
  if (!thinking) return []
  return [
    {
      kind: 'block-final',
      messageId: id,
      blockIndex: 0,
      block: { type: 'thinking', thinking },
      parentToolUseId: null
    }
  ]
}

/** Finalize the open text run (if any), emitting its authoritative block. */
function closeText(state: CursorState): AgentEvent[] {
  if (!state.textId) return []
  const id = state.textId
  const text = state.textAcc
  state.textId = null
  state.textAcc = ''
  if (!text) return []
  return [
    {
      kind: 'block-final',
      messageId: id,
      blockIndex: 0,
      block: { type: 'text', text },
      parentToolUseId: null
    }
  ]
}

/** Concatenate the text blocks of an assistant chunk message. */
function assistantText(raw: Record<string, unknown>): string {
  const msg = raw.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Pull the tool name, args, and result out of a `tool_call` event. cursor wraps
 * the payload as `tool_call: { <kind>ToolCall: { args, result, description }, … }`
 * (e.g. shellToolCall) — the `<kind>ToolCall` key sits directly on `tool_call`,
 * alongside bookkeeping fields like toolCallId/startedAtMs. The shell tool
 * renders as 'Bash' (input {command,cwd}) so it flows through the same command
 * UI as Claude/Codex.
 */
function extractToolCall(raw: Record<string, unknown>): {
  name: string
  args: unknown
  result: unknown
} {
  const outer = raw.tool_call as Record<string, unknown> | undefined
  const key = outer && Object.keys(outer).find((k) => k.endsWith('ToolCall'))
  const payload = (key ? (outer[key] as Record<string, unknown>) : undefined) ?? {}
  if (key === 'shellToolCall') {
    const a = (payload.args as Record<string, unknown>) ?? {}
    return {
      name: 'Bash',
      args: { command: a.command, cwd: a.workingDirectory, description: a.description },
      result: payload.result
    }
  }
  const prettyName = key
    ? key.replace(/ToolCall$/, '').replace(/^./, (c) => c.toUpperCase())
    : 'Tool'
  return { name: prettyName, args: payload.args ?? {}, result: payload.result }
}

/**
 * When cursor-agent rejects an ASK-USER / question tool in headless mode, build
 * an honest one-liner showing what it wanted to ask (prompt + options) instead
 * of the bare "Blocked by Cursor's policy". Returns null for genuinely
 * non-question rejections (a blocked shell command etc), which keep the plain
 * policy string. Detects on the tool NAME (ask/question/elicit/clarify/choice)
 * OR a payload carrying `questions`/`options`/`title` — the structured shape the
 * user reported: {title, questions:[{id,prompt,options:[{id,label}],allowMultiple}]}.
 * The question data may ride on the started `args` or the rejected payload, so
 * both are inspected.
 */
export function describeBlockedQuestion(name: string, ...sources: unknown[]): string | null {
  const src = pickQuestionSource(...sources)
  const nameHint = /ask|question|elicit|clarif|choice|prompt/i.test(name)
  if (!src && !nameHint) return null
  const payload = (src ?? {}) as Record<string, unknown>
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''

  const lines: string[] = []
  const questions = Array.isArray(payload.questions) ? payload.questions : null
  if (questions) {
    for (const raw of questions as Record<string, unknown>[]) {
      const prompt =
        typeof raw?.prompt === 'string'
          ? raw.prompt
          : typeof raw?.question === 'string'
            ? raw.question
            : ''
      const opts = optionLabels(raw?.options)
      let line = prompt.trim()
      if (opts.length) line += ` — options: ${opts.join(', ')}`
      if (line.trim()) lines.push(line.trim())
    }
  } else {
    // a single-question payload (options/prompt sit directly on the payload)
    const prompt =
      typeof payload.prompt === 'string'
        ? payload.prompt
        : typeof payload.question === 'string'
          ? payload.question
          : ''
    const opts = optionLabels(payload.options)
    let line = prompt.trim()
    if (opts.length) line += ` — options: ${opts.join(', ')}`
    if (line.trim()) lines.push(line.trim())
  }

  const body = lines.join(' | ')
  const detail = title && body ? `${title} — ${body}` : title || body
  if (!detail) {
    // a recognized question tool but no readable text — still be honest
    return 'Cursor wanted to ask you a question (blocked in headless mode)'
  }
  return `Cursor wanted to ask (blocked in headless mode): ${detail}`
}

/** the first object among the candidates that carries question-shaped fields */
function pickQuestionSource(...candidates: unknown[]): Record<string, unknown> | null {
  for (const cand of candidates) {
    if (cand && typeof cand === 'object') {
      const o = cand as Record<string, unknown>
      if (
        Array.isArray(o.questions) ||
        Array.isArray(o.options) ||
        (typeof o.title === 'string' && (o.prompt || o.question))
      ) {
        return o
      }
    }
  }
  return null
}

/** pull display labels out of an options array of {id,label}|string entries */
function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  return options
    .map((o) => {
      if (typeof o === 'string') return o
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>
        if (typeof r.label === 'string') return r.label
        if (typeof r.id === 'string') return r.id
      }
      return ''
    })
    .filter((s): s is string => !!s)
}
