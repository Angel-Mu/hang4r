import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  ClaudeUsageSnapshot,
  CodexUsageSnapshot,
  CursorUsageSnapshot,
  UsageWindow
} from '../../shared/protocol'
import { findBinary } from './binaryDiscovery'

const exec = promisify(execFile)

export interface UsagePersistence {
  get(key: string): string | null
  set(key: string, value: string): void
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

type RateLimitWindow = {
  usedPercent?: number
  resetsAt?: number | null
  windowDurationMins?: number | null
}

type RateLimitSnapshot = {
  limitId?: string | null
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  planType?: string | null
}

type AccountRateLimitsResponse = {
  rateLimits?: RateLimitSnapshot
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null
  rateLimitResetCredits?: { availableCount?: number | null } | null
}

type AccountUsageResponse = {
  summary?: { lifetimeTokens?: number | string | bigint | null } | null
}

const CLAUDE_PERSIST_KEY = 'usageCacheV1'
const CODEX_PERSIST_KEY = 'codexUsageCacheV1'
const CURSOR_PERSIST_KEY = 'cursorUsageCacheV1'
const TTL = 600_000
const FORCE_TTL = 30_000
const RETRY_BACKOFF = 20_000

let claudeCache: ClaudeUsageSnapshot | null = null
let claudeInflight: Promise<ClaudeUsageSnapshot> | null = null
let claudeFailedAt = 0
let claudeHydrated = false

let codexCache: CodexUsageSnapshot | null = null
let codexInflight: Promise<CodexUsageSnapshot> | null = null
let codexFailedAt = 0
let codexHydrated = false

let cursorCache: CursorUsageSnapshot | null = null
let cursorInflight: Promise<CursorUsageSnapshot> | null = null
let cursorFailedAt = 0
let cursorHydrated = false

function prettyClaudeLabel(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (s === 'session') return 'Session'
  const m = /week\s*\(([^)]+)\)/.exec(s)
  if (m) return m[1] === 'all models' ? 'Week' : `Week · ${m[1].replace(/\b\w/g, (c) => c.toUpperCase())}`
  return raw.trim()
}

function codexWindowLabel(durationMins?: number | null): string {
  if (durationMins === 300) return '5h'
  if (durationMins === 1440) return 'Day'
  if (durationMins === 10080) return 'Week'
  if (!durationMins || durationMins <= 0) return 'Window'
  if (durationMins % 1440 === 0) return `${Math.round(durationMins / 1440)}d`
  if (durationMins % 60 === 0) return `${Math.round(durationMins / 60)}h`
  return `${durationMins}m`
}

function fmtReset(epochSeconds?: number | null): string {
  if (!epochSeconds) return 'unknown'
  const dt = new Date(epochSeconds * 1000)
  const month = dt.toLocaleString('en-US', { month: 'short' })
  const day = dt.getDate()
  const time = dt
    .toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase()
  return `${month} ${day} at ${time}`
}

/**
 * Parse `cursor-agent about` (plain text, e.g.:
 *   Subscription Tier   Free
 *   Model               Composer 2.5
 *   User Email          angel.malavar@gmail.com
 *   CLI Version         2026.07.09-a3815c0
 * ). Tolerant of missing/reordered/garbage lines — never throws, all fields
 * default to null. Under Electron the CLI colorizes this output (dim labels,
 * cyan header — FORCE_COLOR leaks into the child env), so ANSI codes are
 * stripped before matching; a plain shell capture parses identically.
 */
export function parseCursorAbout(stdout: string): {
  tier: string | null
  email: string | null
  model: string | null
  version: string | null
} {
  // eslint-disable-next-line no-control-regex
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '')
  const field = (label: string): string | null => {
    const m = new RegExp(`^${label}\\s+(.+)$`, 'm').exec(clean)
    return m ? m[1].trim() || null : null
  }
  return {
    tier: field('Subscription Tier'),
    email: field('User Email'),
    model: field('Model'),
    version: field('CLI Version')
  }
}

function hydrateCursorCache(persist: UsagePersistence | undefined): void {
  if (cursorHydrated || !persist) return
  cursorHydrated = true
  try {
    const raw = persist.get(CURSOR_PERSIST_KEY)
    if (raw && !cursorCache) {
      const saved = JSON.parse(raw) as CursorUsageSnapshot
      if (saved.tier || saved.email) cursorCache = { ...saved, stale: true }
    }
  } catch {
    /* corrupt persisted cache */
  }
}

function toNumber(value: number | string | bigint | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function hydrateCache<T extends { fetchedAt: number; stale?: boolean; windows: UsageWindow[] }>(
  persist: UsagePersistence | undefined,
  key: string,
  hydrated: boolean,
  cache: T | null
): { hydrated: boolean; cache: T | null } {
  if (hydrated || !persist) return { hydrated, cache }
  try {
    const raw = persist.get(key)
    if (raw && !cache) {
      const saved = JSON.parse(raw) as T
      if (saved.windows?.length) cache = { ...saved, stale: true }
    }
  } catch {
    /* corrupt persisted cache */
  }
  return { hydrated: true, cache }
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
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'codex app-server request failed'))
      else pending.resolve(msg.result)
    }
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
  }
}

async function readCodexUsage(binary: string): Promise<CodexUsageSnapshot> {
  const client = new CodexRpc(binary)
  try {
    await client.start()
    await client.request('initialize', {
      clientInfo: { name: 'hang4r', title: 'hang4r', version: '0.1.0' }
    })
    client.notify('initialized', {})
    const [limits, usage] = (await Promise.all([
      client.request('account/rateLimits/read', undefined),
      client.request('account/usage/read', undefined)
    ])) as [AccountRateLimitsResponse, AccountUsageResponse]

    const snapshot =
      limits.rateLimitsByLimitId?.codex ??
      Object.values(limits.rateLimitsByLimitId ?? {}).find(Boolean) ??
      limits.rateLimits

    const windows = [snapshot?.primary, snapshot?.secondary]
      .filter((w): w is RateLimitWindow => Boolean(w))
      .map((w) => ({
        label: codexWindowLabel(w.windowDurationMins),
        pct: Math.max(0, Math.min(100, Math.round(w.usedPercent ?? 0))),
        resets: fmtReset(w.resetsAt)
      }))

    return {
      windows,
      fetchedAt: Date.now(),
      planType: snapshot?.planType ?? null,
      lifetimeTokens: toNumber(usage.summary?.lifetimeTokens),
      resetCredits: toNumber(limits.rateLimitResetCredits?.availableCount)
    }
  } finally {
    client.dispose()
  }
}

export const UsageService = {
  async claudeUsage(
    binOverride?: string | null,
    force = false,
    persist?: UsagePersistence
  ): Promise<ClaudeUsageSnapshot> {
    const hydrated = hydrateCache(persist, CLAUDE_PERSIST_KEY, claudeHydrated, claudeCache)
    claudeHydrated = hydrated.hydrated
    claudeCache = hydrated.cache

    const fresh =
      claudeCache && !claudeCache.stale && Date.now() - claudeCache.fetchedAt < (force ? FORCE_TTL : TTL)
    if (fresh && claudeCache) return claudeCache
    if (claudeInflight) return claudeCache ? { ...claudeCache, stale: true } : claudeInflight
    if (Date.now() - claudeFailedAt < RETRY_BACKOFF && claudeCache) return { ...claudeCache, stale: true }

    claudeInflight = (async () => {
      const bin = findBinary('claude', binOverride)
      if (!bin) return claudeCache ?? { windows: [], fetchedAt: Date.now() }
      const { stdout } = await exec(bin, ['-p', '/usage'], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024
      }).catch(() => ({ stdout: '' }))
      const windows: UsageWindow[] = []
      const re = /Current (session|week[^:]*):\s*(\d+)%\s*used\s*·\s*resets\s+([^\n(]+)/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(stdout))) {
        windows.push({ label: prettyClaudeLabel(m[1]), pct: Number(m[2]), resets: m[3].trim() })
      }
      if (windows.length === 0) {
        claudeFailedAt = Date.now()
        if (claudeCache?.windows.length) {
          claudeCache = { ...claudeCache, stale: true }
          return claudeCache
        }
        return { windows: [], fetchedAt: Date.now(), stale: true }
      }
      claudeFailedAt = 0
      claudeCache = { windows, fetchedAt: Date.now() }
      try {
        persist?.set(CLAUDE_PERSIST_KEY, JSON.stringify(claudeCache))
      } catch {
        /* best effort */
      }
      return claudeCache
    })().finally(() => {
      claudeInflight = null
    })
    return claudeCache ? { ...claudeCache, stale: true } : claudeInflight
  },

  async codexUsage(
    binOverride?: string | null,
    force = false,
    persist?: UsagePersistence
  ): Promise<CodexUsageSnapshot> {
    const hydrated = hydrateCache(persist, CODEX_PERSIST_KEY, codexHydrated, codexCache)
    codexHydrated = hydrated.hydrated
    codexCache = hydrated.cache

    const fresh =
      codexCache && !codexCache.stale && Date.now() - codexCache.fetchedAt < (force ? FORCE_TTL : TTL)
    if (fresh && codexCache) return codexCache
    if (codexInflight) return codexCache ? { ...codexCache, stale: true } : codexInflight
    if (Date.now() - codexFailedAt < RETRY_BACKOFF && codexCache) return { ...codexCache, stale: true }

    codexInflight = (async () => {
      const bin = findBinary('codex', binOverride)
      if (!bin) return codexCache ?? { windows: [], fetchedAt: Date.now() }
      try {
        const snapshot = await readCodexUsage(bin)
        if (snapshot.windows.length === 0 && codexCache?.windows.length) {
          codexFailedAt = Date.now()
          codexCache = { ...codexCache, stale: true }
          return codexCache
        }
        codexFailedAt = 0
        codexCache = snapshot
        try {
          persist?.set(CODEX_PERSIST_KEY, JSON.stringify(codexCache))
        } catch {
          /* best effort */
        }
        return codexCache
      } catch {
        codexFailedAt = Date.now()
        if (codexCache?.windows.length) {
          codexCache = { ...codexCache, stale: true }
          return codexCache
        }
        return { windows: [], fetchedAt: Date.now(), stale: true }
      }
    })().finally(() => {
      codexInflight = null
    })

    return codexCache ? { ...codexCache, stale: true } : codexInflight
  },

  async cursorUsage(
    binOverride?: string | null,
    force = false,
    persist?: UsagePersistence
  ): Promise<CursorUsageSnapshot> {
    hydrateCursorCache(persist)

    const fresh =
      cursorCache && !cursorCache.stale && Date.now() - cursorCache.fetchedAt < (force ? FORCE_TTL : TTL)
    if (fresh && cursorCache) return cursorCache
    if (cursorInflight) return cursorCache ? { ...cursorCache, stale: true } : cursorInflight
    if (Date.now() - cursorFailedAt < RETRY_BACKOFF && cursorCache) return { ...cursorCache, stale: true }

    cursorInflight = (async () => {
      const bin = findBinary('cursor-agent', binOverride)
      if (!bin) return cursorCache ?? { tier: null, email: null, model: null, fetchedAt: Date.now() }
      const { stdout } = await exec(bin, ['about'], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        // under Electron the CLI decides it can color (FORCE_COLOR & co. leak
        // into the child env) — ask it not to; the parser strips ANSI anyway
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
      }).catch(() => ({ stdout: '' }))
      const parsed = parseCursorAbout(stdout)
      if (!parsed.tier && !parsed.email) {
        cursorFailedAt = Date.now()
        if (cursorCache) {
          cursorCache = { ...cursorCache, stale: true }
          return cursorCache
        }
        return { tier: null, email: null, model: null, fetchedAt: Date.now(), stale: true }
      }
      cursorFailedAt = 0
      cursorCache = {
        tier: parsed.tier,
        email: parsed.email,
        model: parsed.model,
        fetchedAt: Date.now()
      }
      try {
        persist?.set(CURSOR_PERSIST_KEY, JSON.stringify(cursorCache))
      } catch {
        /* best effort */
      }
      return cursorCache
    })().finally(() => {
      cursorInflight = null
    })

    return cursorCache ? { ...cursorCache, stale: true } : cursorInflight
  }
}
