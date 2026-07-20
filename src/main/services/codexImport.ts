import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../shared/protocol'

const ROOT = join(homedir(), '.codex', 'sessions')

export interface CodexExternalSession {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  messageCount: number
  cwd?: string
  lastMessage?: string
}

export interface CodexSessionPage {
  sessions: CodexExternalSession[]
  hasMore: boolean
}

export interface CodexExternalMessage {
  role: 'user' | 'assistant'
  text: string
}

type CodexTokenUsage = {
  total_tokens?: number
  totalTokens?: number
  input_tokens?: number
  inputTokens?: number
  output_tokens?: number
  outputTokens?: number
}

type CodexTokenCount = {
  type?: string
  info?: {
    last_token_usage?: CodexTokenUsage
    lastTokenUsage?: CodexTokenUsage
    model_context_window?: number
    modelContextWindow?: number
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function codexUsageFromTokenCountPayload(payload: CodexTokenCount): AgentEvent | null {
  const info = payload.info
  const usage = info?.last_token_usage ?? info?.lastTokenUsage
  const contextTokens =
    numberOr(usage?.total_tokens) ??
    numberOr(usage?.totalTokens) ??
    numberOr(usage?.input_tokens) ??
    numberOr(usage?.inputTokens)
  if (!contextTokens) return null
  return {
    kind: 'usage',
    contextTokens,
    contextWindowTokens: numberOr(info?.model_context_window) ?? numberOr(info?.modelContextWindow),
    inputTokens: numberOr(usage?.input_tokens) ?? numberOr(usage?.inputTokens),
    outputTokens: numberOr(usage?.output_tokens) ?? numberOr(usage?.outputTokens)
  }
}

export function codexLatestUsageFromJsonl(raw: string): AgentEvent | null {
  let latest: CodexTokenCount | null = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { type?: string; payload?: CodexTokenCount }
      if (row.type === 'event_msg' && row.payload?.type === 'token_count') latest = row.payload
    } catch {
      /* ignore malformed/incomplete trailing lines */
    }
  }
  return latest ? codexUsageFromTokenCountPayload(latest) : null
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (name.endsWith('.jsonl')) out.push(path)
  }
}

function textPayload(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function codexMessageFromRow(row: {
  type?: string
  payload?: { type?: string; message?: unknown; role?: string; content?: unknown }
}): CodexExternalMessage | null {
  if (row.type !== 'event_msg') return null
  if (row.payload?.type === 'user_message') {
    const text = textPayload(row.payload.message)
    if (!text || text.startsWith('<')) return null
    return { role: 'user', text }
  }
  if (row.payload?.type === 'agent_message') {
    const text = textPayload(row.payload.message)
    if (!text) return null
    return { role: 'assistant', text }
  }
  return null
}

export function codexTranscriptFromJsonl(raw: string): CodexExternalMessage[] {
  const out: CodexExternalMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const msg = codexMessageFromRow(JSON.parse(line))
      if (msg) out.push(msg)
    } catch {
      /* ignore malformed/incomplete trailing lines */
    }
  }
  return out
}

export function codexSummaryFromJsonl(
  raw: string,
  fallback: { id: string; mtime: number }
): CodexExternalSession | null {
  let id = fallback.id
  let cwd: string | undefined
  let createdAt = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as {
        type?: string
        timestamp?: string
        payload?: { id?: string; session_id?: string; cwd?: string; timestamp?: string }
      }
      if (row.type === 'session_meta') {
        id = row.payload?.session_id ?? row.payload?.id ?? id
        cwd = row.payload?.cwd ?? cwd
        createdAt = Date.parse(row.payload?.timestamp ?? row.timestamp ?? '') || createdAt
        break
      }
    } catch {
      /* ignore */
    }
  }
  const messages = codexTranscriptFromJsonl(raw)
  if (!messages.length) return null
  const firstUser = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').slice(0, 80)
  const lastMessage = messages[messages.length - 1]?.text.replace(/\s+/g, ' ').slice(0, 160)
  if (!firstUser && !lastMessage) return null
  return {
    id,
    name: firstUser || lastMessage || 'Codex session',
    createdAt: createdAt || fallback.mtime,
    updatedAt: fallback.mtime,
    messageCount: messages.length,
    cwd,
    lastMessage
  }
}

export class CodexImport {
  static available(): boolean {
    return existsSync(ROOT)
  }

  static listSessions(roots?: string[], opts?: { offset?: number; limit?: number }): CodexSessionPage {
    const empty: CodexSessionPage = { sessions: [], hasMore: false }
    if (!existsSync(ROOT)) return empty
    const offset = Math.max(0, opts?.offset ?? 0)
    const limit = Math.max(1, opts?.limit ?? 100)
    const norm = (roots ?? []).map((r) => r.replace(/\/+$/, '')).filter(Boolean)
    const inRoots = (cwd?: string): boolean => {
      if (!norm.length) return true
      if (!cwd) return false
      const c = cwd.replace(/\/+$/, '')
      return norm.some((r) => c === r || c.startsWith(r + '/'))
    }
    const paths: string[] = []
    try {
      walk(ROOT, paths)
    } catch {
      return empty
    }
    const files = paths
      .map((path) => ({ path, id: path.replace(/\.jsonl$/, '').split('/').pop() ?? path, mtime: statSync(path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)

    const sessions: CodexExternalSession[] = []
    let matched = 0
    let hasMore = false
    for (const file of files) {
      let summary: CodexExternalSession | null = null
      try {
        summary = codexSummaryFromJsonl(readFileSync(file.path, 'utf8'), file)
      } catch {
        continue
      }
      if (!summary || !inRoots(summary.cwd)) continue
      if (matched >= offset) {
        if (sessions.length >= limit) {
          hasMore = true
          break
        }
        sessions.push(summary)
      }
      matched++
    }
    return { sessions, hasMore }
  }

  static sessionFile(id: string): string | null {
    if (!existsSync(ROOT)) return null
    const files: string[] = []
    walk(ROOT, files)
    return files.find((path) => path.includes(id)) ?? null
  }

  static getTranscript(id: string): CodexExternalMessage[] {
    const path = this.sessionFile(id)
    if (!path) return []
    try {
      return codexTranscriptFromJsonl(readFileSync(path, 'utf8'))
    } catch {
      return []
    }
  }

  static latestUsage(id: string): AgentEvent | null {
    const path = this.sessionFile(id)
    if (!path) return null
    return codexLatestUsageFromJsonl(readFileSync(path, 'utf8'))
  }
}
