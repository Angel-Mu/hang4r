import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelChoice } from '../../shared/protocol'
import { findBinary } from './binaryDiscovery'

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export type CodexModel = {
  id?: string
  model?: string
  displayName?: string
  display_name?: string
  slug?: string
  hidden?: boolean
  contextWindow?: number
  context_window?: number
  maxContextWindow?: number
  max_context_window?: number
  modelContextWindow?: number
  model_context_window?: number
  isDefault?: boolean
}

export type ModelListResponse = {
  data?: CodexModel[]
  nextCursor?: string | null
}

export type CodexModelList = {
  choices: ModelChoice[]
  defaultContextWindowTokens?: number
}

const FALLBACK_CODEX_MODELS: ModelChoice[] = [{ value: '', label: 'Default model' }]

const UNSUPPORTED_CODEX_MODELS = new Set(['gpt-5-codex'])

/**
 * Codex app-server owns the account-aware model catalog. Querying it keeps
 * hang4r aligned with the installed/logged-in CLI instead of shipping stale
 * model slugs in the renderer.
 */
export class CodexModelService {
  static async list(binaryOverride?: string | null): Promise<ModelChoice[]> {
    const binary = findBinary('codex', binaryOverride)
    if (!binary) return FALLBACK_CODEX_MODELS

    try {
      const models = await queryCodexModels(binary)
      return models.choices.length
        ? [
            {
              value: '',
              label: 'Default model',
              ...(models.defaultContextWindowTokens
                ? { contextWindowTokens: models.defaultContextWindowTokens }
                : {})
            },
            ...models.choices
          ]
        : FALLBACK_CODEX_MODELS
    } catch {
      return FALLBACK_CODEX_MODELS
    }
  }
}

async function queryCodexModels(binary: string): Promise<CodexModelList> {
  const client = new CodexRpc(binary)
  try {
    await client.start()
    await client.request('initialize', {
      clientInfo: { name: 'hang4r', title: 'hang4r', version: '0.1.0' }
    })
    client.notify('initialized', {})

    const pages: ModelListResponse[] = []
    let cursor: string | null | undefined = undefined
    do {
      const page = (await client.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false
      })) as ModelListResponse
      pages.push(page)
      cursor = page.nextCursor
    } while (cursor)
    return codexModelChoicesFromPages(pages, readCodexModelContext())
  } finally {
    client.dispose()
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function modelContextWindow(model: CodexModel): number | undefined {
  return (
    positiveNumber(model.maxContextWindow) ??
    positiveNumber(model.max_context_window) ??
    positiveNumber(model.modelContextWindow) ??
    positiveNumber(model.model_context_window) ??
    positiveNumber(model.contextWindow) ??
    positiveNumber(model.context_window)
  )
}

export function codexModelChoicesFromPages(
  pages: ModelListResponse[],
  contextByModel = new Map<string, number>()
): CodexModelList {
  const seen = new Set<string>()
  const choices: ModelChoice[] = []
  let defaultContextWindowTokens: number | undefined
  for (const page of pages) {
    for (const model of page.data ?? []) {
      const value = model.model?.trim()
      if (!value || model.hidden || UNSUPPORTED_CODEX_MODELS.has(value) || seen.has(value)) continue
      seen.add(value)
      const contextWindowTokens = modelContextWindow(model) ?? contextByModel.get(value)
      if (model.isDefault && contextWindowTokens) defaultContextWindowTokens = contextWindowTokens
      choices.push({
        value,
        label: model.displayName?.trim() || model.display_name?.trim() || value,
        ...(contextWindowTokens ? { contextWindowTokens } : {})
      })
    }
  }
  return { choices, defaultContextWindowTokens }
}

function readCodexModelContext(): Map<string, number> {
  const out = new Map<string, number>()
  const path = join(homedir(), '.codex', 'models_cache.json')
  if (!existsSync(path)) return out
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { models?: CodexModel[] }
    for (const model of parsed.models ?? []) {
      const value = (model.model ?? model.slug ?? model.id)?.trim()
      const contextWindowTokens = modelContextWindow(model)
      if (value && contextWindowTokens) out.set(value, contextWindowTokens)
    }
  } catch {
    /* cache is best-effort; app-server model/list remains authoritative */
  }
  return out
}

class CodexRpc {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private timeout: NodeJS.Timeout | null = null

  constructor(private binary: string) {}

  start(): Promise<void> {
    this.proc = spawn(this.binary, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    })
    this.proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk.toString()))
    this.proc.stderr.on('data', () => {})
    this.proc.on('exit', () => this.rejectAll(new Error('codex app-server exited')))
    this.proc.on('error', (err) => this.rejectAll(err))
    this.timeout = setTimeout(() => {
      this.rejectAll(new Error('timed out waiting for codex app-server'))
      this.dispose()
    }, 10_000)
    return Promise.resolve()
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  dispose(): void {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    if (this.proc && !this.proc.killed) this.proc.kill()
    this.proc = null
  }

  private send(msg: Record<string, unknown>): void {
    this.proc?.stdin.write(JSON.stringify(msg) + '\n')
  }

  private handleStdout(text: string): void {
    this.stdoutBuf += text
    const lines = this.stdoutBuf.split('\n')
    this.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (!msg.id) continue
      const pending = this.pending.get(msg.id)
      if (!pending) continue
      this.pending.delete(msg.id)
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? 'codex app-server request failed'))
      } else {
        pending.resolve(msg.result)
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
  }
}
