import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AgentEvent, PromptImage } from '../../../shared/protocol'
import type { AdapterStartOptions, AgentAdapter } from './types'

/**
 * Drives OpenAI Codex through its NATIVE `codex app-server` JSON-RPC protocol —
 * the same surface the official VS Code extension uses. This replaces the
 * earlier ACP-based adapter: the native protocol exposes the full capability
 * set ACP lacks (thread rename/archive/list, turn/steer, review/start,
 * command/exec remote control, fs utilities, ChatGPT-subscription auth and
 * rate limits).
 *
 * Wire: newline-delimited JSON-RPC 2.0 over stdio (the "jsonrpc" header is
 * omitted on the wire). Lifecycle: initialize → initialized → thread/start
 * (or thread/resume) → turn/start per user message → item/* notifications
 * stream → turn/completed. Approvals arrive as server-initiated REQUESTS that
 * we must answer — surfaced to the UI as permission-request events.
 *
 * Protocol reference: openai/codex codex-rs/app-server/README.md.
 */

/**
 * Map our shared effort levels onto codex's `model_reasoning_effort` config
 * (minimal | low | medium | high). Claude's higher tiers (xhigh/max) clamp to
 * codex's ceiling of 'high'; 'auto'/unset leaves codex on its own default.
 */
function codexEffort(effort?: string): string | null {
  switch (effort) {
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high'
    default:
      return null
  }
}

const CHATGPT_UNSUPPORTED_MODELS = new Set(['gpt-5-codex'])

function codexModel(model?: string | null): string | undefined {
  const value = model?.trim()
  if (!value || CHATGPT_UNSUPPORTED_MODELS.has(value)) return undefined
  return value
}

export class CodexAdapter implements AgentAdapter {
  readonly backend = 'codex' as const

  private proc: ChildProcessWithoutNullStreams | null = null
  private listeners: Array<(ev: AgentEvent) => void> = []
  private stdoutBuf = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  /** server-initiated approval requests awaiting a user decision, by our requestId */
  private pendingApprovals = new Map<string, number>()
  private threadId: string | null = null
  private currentTurnId: string | null = null
  private ready: Promise<void> | null = null
  private disposed = false
  /** running token totals for the in-flight turn (from thread/tokenUsage/updated) */
  private lastTokens: { input?: number; output?: number; context?: number; window?: number } = {}
  private opts: AdapterStartOptions | null = null

  onEvent(cb: (ev: AgentEvent) => void): void {
    this.listeners.push(cb)
  }
  private emit(ev: AgentEvent): void {
    for (const cb of this.listeners) cb(ev)
  }

  /* ---------------- lifecycle ---------------- */

  start(opts: AdapterStartOptions): void {
    this.opts = { ...opts, model: codexModel(opts.model) }
    if (!existsSync(opts.binaryPath)) {
      this.emit({
        kind: 'turn-complete',
        isError: true,
        errorMessage: `Codex CLI not found at ${opts.binaryPath}. Install it (npm i -g @openai/codex) and log in, or set its path in Settings → Models.`
      })
      this.emit({ kind: 'exit', code: -1 })
      return
    }
    const cwd = existsSync(opts.cwd) ? opts.cwd : homedir()
    // reasoning effort maps onto codex's `model_reasoning_effort` config (a real,
    // documented -c override the app-server accepts; codex caps at 'high').
    const args = ['app-server']
    const effort = codexEffort(opts.effort)
    if (effort) args.unshift('-c', `model_reasoning_effort=${effort}`)
    this.proc = spawn(opts.binaryPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // local sessions carry the hang4r browser CLI env (ssh passes none)
      env: { ...process.env, ...opts.env }
    })

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString()
      const lines = this.stdoutBuf.split('\n')
      this.stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        this.handleMessage(line)
      }
    })
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.emit({ kind: 'stderr', text: chunk.toString() })
    })
    this.proc.on('exit', (code) => {
      if (!this.disposed) this.emit({ kind: 'exit', code })
      this.proc = null
    })
    this.proc.on('error', (err) => {
      this.emit({ kind: 'turn-complete', isError: true, errorMessage: String(err) })
      this.emit({ kind: 'exit', code: -1 })
    })

    this.ready = this.handshake(this.opts).catch((err) => {
      this.emit({
        kind: 'turn-complete',
        isError: true,
        errorMessage: `codex app-server init failed: ${err instanceof Error ? err.message : String(err)}`
      })
      throw err
    })
  }

  private async handshake(opts: AdapterStartOptions): Promise<void> {
    const initResult = (await this.request('initialize', {
      clientInfo: { name: 'hang4r', title: 'hang4r', version: '0.1.0' }
    })) as { userAgent?: string } | undefined
    this.notify('initialized', {})

    const thread = opts.resumeSessionId
      ? ((await this.request(opts.fork ? 'thread/fork' : 'thread/resume', {
          threadId: opts.resumeSessionId
        })) as { thread: { id: string } })
      : ((await this.request('thread/start', { cwd: opts.cwd })) as { thread: { id: string } })
    this.threadId = thread.thread.id

    this.emit({
      kind: 'init',
      backendSessionId: this.threadId,
      model: codexModel(opts.model) || 'codex-default',
      tools: [],
      mcpServers: [],
      skills: [],
      slashCommands: [],
      plugins: [],
      permissionMode: opts.permissionMode,
      version: initResult?.userAgent ?? 'codex app-server'
    })
  }

  prompt(text: string, images?: PromptImage[]): void {
    void this.ready
      ?.then(async () => {
        this.emit({ kind: 'user-text', text, images })
        this.lastTokens = {}
        const input: unknown[] = (images ?? []).map((img) => ({
          type: 'image',
          url: `data:${img.mediaType};base64,${img.base64}`
        }))
        input.push({ type: 'text', text })
        await this.request('turn/start', {
          threadId: this.threadId,
          input,
          ...(this.opts?.model ? { model: this.opts.model } : {}),
          ...this.permissionParams()
        })
      })
      .catch((err) => {
        this.emit({ kind: 'turn-complete', isError: true, errorMessage: String(err) })
      })
  }

  /** map our PermissionMode onto Codex approvalPolicy + sandboxPolicy */
  private permissionParams(): Record<string, unknown> {
    const cwd = this.opts?.cwd
    switch (this.opts?.permissionMode) {
      case 'bypassPermissions':
        return {
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' }
        }
      case 'acceptEdits':
        return {
          approvalPolicy: 'on-request',
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: cwd ? [cwd] : [], networkAccess: true }
        }
      default:
        return { approvalPolicy: 'on-request' }
    }
  }

  interrupt(): void {
    if (this.threadId && this.currentTurnId) {
      void this.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.currentTurnId
      }).catch(() => {})
    }
  }

  respondPermission(requestId: string, decision: string): void {
    const rpcId = this.pendingApprovals.get(requestId)
    if (rpcId === undefined) return
    this.pendingApprovals.delete(requestId)
    this.send({ id: rpcId, result: { decision } })
    this.emit({ kind: 'permission-resolved', requestId, decision })
  }

  setModel(model: string): void {
    // applied on the next turn/start (turn overrides persist for the thread)
    if (this.opts) this.opts.model = codexModel(model)
  }

  setTitle(title: string): void {
    if (this.threadId) {
      void this.request('thread/name/set', { threadId: this.threadId, name: title }).catch(() => {})
    }
  }

  /**
   * Real conversation rewind via the app-server `thread/rollback` RPC: drop the
   * last `turns` turns from this thread's context (verified live — after
   * numTurns:1 the next turn no longer sees the rolled-back turn's content). The
   * thread id is unchanged, so the following turn/start just continues from the
   * truncated point. Returns false if the backend rejects the call (it's
   * upstream-deprecated — "will be removed soon" — or the history replay fails),
   * so the caller can fall back to an honest append instead of dropping the edit.
   */
  async rewindTurns(turns: number): Promise<boolean> {
    if (turns <= 0) return false
    try {
      await this.ready
      if (!this.threadId) return false
      await this.request('thread/rollback', { threadId: this.threadId, numTurns: turns })
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.proc) {
      const p = this.proc
      setTimeout(() => {
        if (!p.killed) p.kill('SIGKILL')
      }, 2000)
      p.kill()
      this.proc = null
    }
  }

  /* ---------------- JSON-RPC plumbing ---------------- */

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  private send(msg: Record<string, unknown>): void {
    this.proc?.stdin.write(JSON.stringify(msg) + '\n')
  }

  private handleMessage(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      this.emit({ kind: 'stderr', text: `unparseable app-server line: ${line.slice(0, 200)}` })
      return
    }

    // response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id as number)
      if (waiter) {
        this.pending.delete(msg.id as number)
        if (msg.error) {
          waiter.reject(new Error((msg.error as { message?: string }).message ?? 'rpc error'))
        } else {
          waiter.resolve(msg.result)
        }
      }
      return
    }

    // server-initiated REQUEST (approvals etc.) — must be answered
    if (msg.id !== undefined && msg.method !== undefined) {
      this.handleServerRequest(msg.id as number, msg.method as string, msg.params as never)
      return
    }

    // notification
    if (msg.method !== undefined) {
      this.handleNotification(msg.method as string, (msg.params ?? {}) as Record<string, unknown>)
    }
  }

  private handleServerRequest(id: number, method: string, params: Record<string, unknown>): void {
    if (method === 'item/commandExecution/requestApproval') {
      const requestId = `codex-approval-${id}`
      this.pendingApprovals.set(requestId, id)
      this.emit({
        kind: 'permission-request',
        requestId,
        tool: 'command',
        summary: String(params.command ?? params.reason ?? 'Run command'),
        detail: params.cwd ? `cwd: ${params.cwd}` : undefined,
        options: ['accept', 'acceptForSession', 'decline']
      })
      return
    }
    if (method === 'item/fileChange/requestApproval') {
      const requestId = `codex-approval-${id}`
      this.pendingApprovals.set(requestId, id)
      this.emit({
        kind: 'permission-request',
        requestId,
        tool: 'file-change',
        summary: String(params.reason ?? 'Apply file changes'),
        options: ['accept', 'acceptForSession', 'decline']
      })
      return
    }
    // unknown server request — decline safely rather than hang the turn
    this.send({ id, result: { decision: 'decline' } })
  }

  private handleNotification(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case 'turn/started': {
        const turn = p.turn as { id?: string } | undefined
        this.currentTurnId = turn?.id ?? null
        break
      }
      case 'item/started': {
        const item = p.item as Record<string, unknown> | undefined
        if (item) this.onItemStarted(item)
        break
      }
      case 'item/agentMessage/delta':
        this.emit({
          kind: 'block-delta',
          messageId: String(p.itemId),
          blockIndex: 0,
          text: String(p.delta ?? ''),
          parentToolUseId: null
        })
        break
      case 'item/reasoning/summaryTextDelta':
        this.emit({
          kind: 'block-delta',
          messageId: `${p.itemId}-thinking`,
          blockIndex: (p.summaryIndex as number) ?? 0,
          text: String(p.delta ?? ''),
          parentToolUseId: null
        })
        break
      case 'item/commandExecution/outputDelta':
        // live command output — surfaced in the final tool result for now
        break
      case 'item/completed': {
        const item = p.item as Record<string, unknown> | undefined
        if (item) this.onItemCompleted(item)
        break
      }
      case 'thread/tokenUsage/updated': {
        const usage = (p.tokenUsage ?? p.usage ?? p) as Record<string, unknown>
        const breakdown =
          ((usage.last as Record<string, unknown> | undefined) ??
            (usage.total as Record<string, unknown> | undefined) ??
            usage) as Record<string, unknown>
        const input = numberOr(breakdown.inputTokens ?? breakdown.input_tokens, this.lastTokens.input) ?? 0
        const context = numberOr(breakdown.totalTokens ?? breakdown.total_tokens, input) ?? input
        this.lastTokens = {
          input,
          output: numberOr(breakdown.outputTokens ?? breakdown.output_tokens, this.lastTokens.output),
          context,
          window: numberOr(usage.modelContextWindow ?? usage.model_context_window, this.lastTokens.window)
        }
        // live context size → per-session gauge fills in while the agent works
        if (context > 0) {
          this.emit({
            kind: 'usage',
            contextTokens: context,
            contextWindowTokens: this.lastTokens.window,
            inputTokens: input,
            outputTokens: this.lastTokens?.output ?? 0
          })
        }
        break
      }
      case 'turn/plan/updated': {
        const plan = (p.plan as { step: string; status: string }[]) ?? []
        this.emit({
          kind: 'plan',
          entries: plan.map((e) => ({
            step: e.step,
            status:
              e.status === 'completed'
                ? 'completed'
                : e.status === 'inProgress'
                  ? 'inProgress'
                  : 'pending'
          }))
        })
        break
      }
      case 'turn/completed': {
        const turn = p.turn as { status?: string; error?: { message?: string } } | undefined
        const failed = turn?.status === 'failed'
        this.emit({
          kind: 'turn-complete',
          isError: failed,
          errorMessage: failed ? (turn?.error?.message ?? 'turn failed') : undefined,
          result: turn?.status,
          inputTokens: this.lastTokens.input,
          outputTokens: this.lastTokens.output,
          // Codex totalTokens is the value its CLI /status reports as context used.
          contextTokens: this.lastTokens.context || undefined,
          contextWindowTokens: this.lastTokens.window
        })
        this.currentTurnId = null
        break
      }
      case 'account/rateLimits/updated':
        // ChatGPT plan limits — shape varies session to session and we don't
        // parse real windows/resets out of it yet. The 'rate-limit' event
        // kind and the renderer's rateLimits map exist only for Claude's
        // five_hour/weekly/daily quota windows (title-bar gauge strip); a
        // placeholder `rateLimitType: 'codex'` entry used to get merged into
        // that same map and rendered as a bogus "CODEX / now" gauge chip
        // alongside the real Claude windows. Drop it until this event is
        // actually parsed into real window data.
        break
      case 'error': {
        const err = p.error as { message?: string } | undefined
        this.emit({ kind: 'stderr', text: `codex error: ${err?.message ?? 'unknown'}` })
        break
      }
      default:
        break
    }
  }

  /** map item/started to tool_use blocks so the chat renders work as it begins */
  private onItemStarted(item: Record<string, unknown>): void {
    const id = String(item.id)
    const type = item.type as string
    if (type === 'commandExecution') {
      this.emitTool(id, 'Bash', { command: item.command, cwd: item.cwd })
    } else if (type === 'fileChange') {
      this.emitTool(id, 'Edit', { changes: item.changes })
    } else if (type === 'mcpToolCall') {
      this.emitTool(id, `${item.server}.${item.tool}`, item.arguments)
    } else if (type === 'webSearch') {
      this.emitTool(id, 'WebSearch', { query: item.query })
    } else if (type === 'collabToolCall') {
      this.emitTool(id, `collab:${item.tool}`, { prompt: item.prompt })
    }
  }

  private emitTool(id: string, name: string, input: unknown): void {
    this.emit({
      kind: 'block-final',
      messageId: `item-${id}`,
      blockIndex: 0,
      block: { type: 'tool_use', id, name, input },
      parentToolUseId: null
    })
  }

  private onItemCompleted(item: Record<string, unknown>): void {
    const id = String(item.id)
    const type = item.type as string
    if (type === 'agentMessage') {
      // authoritative full text replaces accumulated deltas (same block key)
      this.emit({
        kind: 'block-final',
        messageId: id,
        blockIndex: 0,
        block: { type: 'text', text: String(item.text ?? '') },
        parentToolUseId: null
      })
    } else if (type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary.join('\n') : ''
      if (summary) {
        this.emit({
          kind: 'block-final',
          messageId: `${id}-thinking`,
          blockIndex: 0,
          block: { type: 'thinking', thinking: summary },
          parentToolUseId: null
        })
      }
    } else if (type === 'commandExecution') {
      this.emit({
        kind: 'tool-result',
        toolUseId: id,
        content: {
          output: item.aggregatedOutput,
          exitCode: item.exitCode,
          status: item.status
        },
        isError: item.status === 'failed',
        parentToolUseId: null
      })
    } else if (type === 'fileChange') {
      this.emit({
        kind: 'tool-result',
        toolUseId: id,
        content: { changes: item.changes, status: item.status },
        isError: item.status === 'failed',
        parentToolUseId: null
      })
    } else if (type === 'mcpToolCall' || type === 'webSearch' || type === 'collabToolCall') {
      this.emit({
        kind: 'tool-result',
        toolUseId: id,
        content: item.result ?? item.action ?? item.status ?? null,
        isError: item.status === 'failed',
        parentToolUseId: null
      })
    }
  }
}

function numberOr(v: unknown, fallback: number | undefined): number | undefined {
  return typeof v === 'number' ? v : fallback
}
