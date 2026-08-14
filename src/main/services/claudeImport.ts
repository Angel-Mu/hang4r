import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Read-only importer for Claude Code's own session history. Claude stores each
 * session as a JSONL transcript at ~/.claude/projects/<encoded-cwd>/<id>.jsonl,
 * one event per line (type: user | assistant | …). Since hang4r drives the same
 * engine these could even be resumed, but for parity with the Cursor importer we
 * surface them and seed a fresh session with the transcript.
 */
// Claude Code's session-history root. Read-only. Overridable ONLY for e2e (point
// it at a temp dir holding a crafted transcript) via HANG4R_CLAUDE_PROJECTS_DIR —
// real users never set it, so this stays the real ~/.claude/projects untouched.
const ROOT = process.env.HANG4R_CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects')

export interface ExternalSession {
  id: string
  name: string
  /** custom name set via Claude Code's /rename (shown bold, matched in search) */
  customName?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** original working directory — used to resume in the right place */
  cwd?: string
  /** last user/assistant message (for the picker preview + search) */
  lastMessage?: string
}

export interface SessionPage {
  sessions: ExternalSession[]
  hasMore: boolean
}

export interface ExternalMessage {
  role: 'user' | 'assistant'
  text: string
}

/** first-prompt patterns that mean "not a user work session" → drop it entirely */
const NOISE = [/^Hello memory agent/i, /^You are a Claude-Mem/i, /^You are claude-mem/i]
/** first-prompt patterns that are boilerplate → skip for the title, keep scanning */
const SKIP_TITLE = [/^This session is being continued/i, /^Caveat:/i, /^<command-/i]

/** cheap cwd read from a transcript's head — avoids full-reading noise files */
function peekCwd(path: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(16384)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n))
    return m ? m[1].replace(/\\(.)/g, '$1') : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** pull the text out of a Claude message content (string or block array) */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
  }
  return ''
}

/** parse a rewind anchor out of raw jsonl content (local file OR remote cat) */
export function parseRewindAnchor(
  raw: string,
  text: string,
  occurrenceFromEnd: number
): { parentUuid: string | null } | null {
  const want = text.trim()
  const parents: (string | null)[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: { type?: string; uuid?: string; parentUuid?: string; message?: { content?: unknown } }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type !== 'user') continue
    const t = textOf(ev.message?.content).trim()
    if (!t || t.startsWith('<')) continue // tool results / meta, not prompts
    if (t === want) parents.push(ev.parentUuid ?? null)
  }
  const idx = parents.length - 1 - occurrenceFromEnd
  if (idx < 0) return null
  return { parentUuid: parents[idx] }
}

export interface AfterMessage {
  role: 'user' | 'assistant'
  text: string
  at: number
}

/**
 * User/assistant messages strictly AFTER the line carrying `afterUuid`. Pure
 * (operates on raw jsonl text) so the external-turn re-sync is unit-testable.
 * Tool results / injected meta (text starting with '<') and blank lines drop.
 */
export function parseMessagesAfter(raw: string, afterUuid: string): AfterMessage[] {
  const out: AfterMessage[] = []
  let seen = false
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    if (!seen) {
      if (line.includes(`"uuid":"${afterUuid}"`)) seen = true
      continue
    }
    let ev: { type?: string; message?: { content?: unknown }; timestamp?: string }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue
    const text = textOf(ev.message?.content).trim()
    if (!text || text.startsWith('<')) continue // tool results / injected meta
    out.push({ role: ev.type, text, at: ev.timestamp ? Date.parse(ev.timestamp) || 0 : 0 })
  }
  return out
}

/**
 * Keep only GENUINELY-external turns: those written strictly after `turnEndedAt`
 * (when hang4r's OWN turn ended). Our own turn's lines carry `at <= turnEndedAt`,
 * so this drops them — the guard that stops hang4r re-importing its OWN just-ended
 * turn as an "⇄ interactive CLI" turn (the phantom fork after a user interrupt,
 * Angel). Only reliable when `turnEndedAt` is the CURRENT turn's end — recorded
 * SYNCHRONOUSLY at turn-complete so a resync poll can't read a stale watermark.
 * Messages without a parseable timestamp pass (uuid position already applied).
 */
export function filterExternalTurns(msgs: AfterMessage[], turnEndedAt?: number): AfterMessage[] {
  if (!turnEndedAt) return msgs
  return msgs.filter((m) => !m.at || m.at > turnEndedAt)
}

/**
 * True if the conversation ends mid-tool: an assistant `tool_use` block with no
 * matching `tool_result`. Claude REFUSES to --resume such a jsonl (it's an
 * incomplete turn), so every follow-up re-errors with error_during_execution.
 * This is exactly what an aborted turn leaves behind — including a turn that
 * aborted in an EXTERNAL interactive CLI, whose fork we adopt without ever
 * flipping our own status to 'error' (so status alone can't catch it).
 */
export function hasDanglingToolUse(raw: string): boolean {
  const toolUse = new Set<string>()
  const toolResult = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: { message?: { content?: unknown } }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const content = ev.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: string; id?: string; tool_use_id?: string }
      if (b.type === 'tool_use' && b.id) toolUse.add(b.id)
      else if (b.type === 'tool_result' && b.tool_use_id) toolResult.add(b.tool_use_id)
    }
  }
  for (const id of toolUse) if (!toolResult.has(id)) return true
  return false
}

/**
 * The parentUuid to `--resume-session-at` so a fork drops the POISONED turn (the
 * one carrying the dangling tool_use) and everything after it. Unlike the
 * last-user-text anchor, this targets the poison directly, so retry prompts
 * ("continue") that pile up after the poison can't drift the anchor past it.
 *
 * We find the earliest message with an unmatched tool_use, walk up to that
 * turn's ROOT user prompt (a real text prompt, not a tool-loop tool_result line),
 * and return the message BEFORE it. null when there's no poison, or we can't
 * resolve the turn root (broken parent chain / poison in the very first turn) —
 * the caller then falls back to the last-user-text anchor.
 */
export function parsePoisonAnchor(raw: string): string | null {
  type Entry = { parentUuid: string | null; type?: string; content: unknown }
  const byUuid = new Map<string, Entry>()
  const order: string[] = []
  const toolResult = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: { uuid?: string; parentUuid?: string; type?: string; message?: { content?: unknown } }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const content = ev.message?.content
    if (ev.uuid) {
      byUuid.set(ev.uuid, { parentUuid: ev.parentUuid ?? null, type: ev.type, content })
      order.push(ev.uuid)
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as { type?: string; tool_use_id?: string }
        if (b.type === 'tool_result' && b.tool_use_id) toolResult.add(b.tool_use_id)
      }
    }
  }
  const hasDangling = (e: Entry): boolean =>
    Array.isArray(e.content) &&
    e.content.some((block) => {
      if (!block || typeof block !== 'object') return false
      const b = block as { type?: string; id?: string }
      return b.type === 'tool_use' && typeof b.id === 'string' && !toolResult.has(b.id)
    })
  let poison: string | null = null
  for (const uuid of order) {
    if (hasDangling(byUuid.get(uuid)!)) {
      poison = uuid
      break
    }
  }
  if (!poison) return null

  // a turn root is a real user prompt — a 'user' entry whose content is text, NOT
  // the tool_result 'user' lines that carry a tool-loop mid-turn
  const isTurnRoot = (e: Entry): boolean => {
    if (e.type !== 'user') return false
    if (typeof e.content === 'string') return true
    if (!Array.isArray(e.content)) return false
    return !e.content.some(
      (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'
    )
  }
  let cur: Entry | undefined = byUuid.get(poison)
  const seen = new Set<string>()
  while (cur && !isTurnRoot(cur)) {
    const p = cur.parentUuid
    if (!p || seen.has(p)) return null // broken/looping chain → let caller fall back
    seen.add(p)
    cur = byUuid.get(p)
  }
  if (!cur) return null
  return cur.parentUuid ?? null // resume-at the message BEFORE the poisoned turn
}

/**
 * Repair a POISONED transcript so `claude --resume` accepts it again. A poisoned
 * jsonl ends a turn with an assistant `tool_use` block that never got a matching
 * `tool_result` (the tool was killed mid-flight — our own SIGKILL on dispose/quit,
 * or an OS OOM/crash). Claude refuses to --resume such a file and every retry
 * re-errors with error_during_execution.
 *
 * For each dangling tool_use we append ONE synthetic `type:"user"` line carrying a
 * single `tool_result` block for that id (is_error, a short "interrupted" note),
 * with a fresh uuid and parentUuid = the uuid of the line that carried the dangling
 * tool_use — so the CLI's turn tree stays intact and the API messages become valid.
 * Unlike fork-truncating past the poison, this KEEPS the aborted turn.
 *
 * The line shape mirrors what the CLI itself writes for an aborted tool_result
 * (verified against real ~/.claude transcripts, Claude Code v2.1.x): the metadata
 * fields (cwd, sessionId, version, gitBranch, userType, entrypoint, isSidechain)
 * are copied from the carrying line so the appended line matches its neighbours.
 *
 * Pure: takes the raw jsonl, returns the healed jsonl (original bytes untouched,
 * heal lines appended) or null when there was nothing to heal. Exported for tests.
 */
export function healPoisonedTranscript(raw: string): string | null {
  interface Entry {
    uuid?: string
    parentUuid?: string | null
    type?: string
    sessionId?: string
    cwd?: string
    version?: string
    gitBranch?: string
    userType?: string
    entrypoint?: string
    isSidechain?: boolean
    content?: unknown
  }
  const entries: Entry[] = []
  const matched = new Set<string>() // tool_use ids that already have a tool_result
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const content = (ev.message as { content?: unknown } | undefined)?.content
    entries.push({
      uuid: ev.uuid as string | undefined,
      parentUuid: (ev.parentUuid as string | null | undefined) ?? null,
      type: ev.type as string | undefined,
      sessionId: ev.sessionId as string | undefined,
      cwd: ev.cwd as string | undefined,
      version: ev.version as string | undefined,
      gitBranch: ev.gitBranch as string | undefined,
      userType: ev.userType as string | undefined,
      entrypoint: ev.entrypoint as string | undefined,
      isSidechain: ev.isSidechain as boolean | undefined,
      content
    })
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as { type?: string; tool_use_id?: string }
        if (b.type === 'tool_result' && b.tool_use_id) matched.add(b.tool_use_id)
      }
    }
  }
  // newest-wins fallbacks for metadata a carrying line might lack
  const pick = (k: keyof Entry): string | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const v = entries[i][k]
      if (typeof v === 'string') return v
    }
    return undefined
  }
  const fSession = pick('sessionId')
  const fCwd = pick('cwd')
  const fVersion = pick('version')
  const fBranch = pick('gitBranch')
  const fUserType = pick('userType') ?? 'external'
  const fEntrypoint = pick('entrypoint') ?? 'sdk-cli'

  const NOTE = '[Tool interrupted — the session was restarted before it finished]'
  const appended: string[] = []
  for (const e of entries) {
    if (!e.uuid || !Array.isArray(e.content)) continue
    for (const block of e.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: string; id?: string }
      if (b.type !== 'tool_use' || typeof b.id !== 'string' || matched.has(b.id)) continue
      const heal: Record<string, unknown> = {
        parentUuid: e.uuid,
        isSidechain: e.isSidechain ?? false,
        userType: e.userType ?? fUserType,
        cwd: e.cwd ?? fCwd,
        sessionId: e.sessionId ?? fSession,
        version: e.version ?? fVersion,
        gitBranch: e.gitBranch ?? fBranch,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: b.id, content: NOTE, is_error: true }]
        },
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        sourceToolAssistantUUID: e.uuid,
        toolUseResult: NOTE,
        entrypoint: e.entrypoint ?? fEntrypoint,
        interruptedByShutdown: true
      }
      appended.push(JSON.stringify(heal))
      matched.add(b.id) // never synthesize two results for the same id
    }
  }
  if (!appended.length) return null
  const base = raw.endsWith('\n') || raw === '' ? raw : raw + '\n'
  return base + appended.join('\n') + '\n'
}

export const ClaudeImport = {
  available(): boolean {
    return existsSync(ROOT)
  },

  /**
   * List importable Claude sessions, newest first, one page at a time. If `roots`
   * is given (the user's added workspace paths), only sessions whose original cwd
   * is inside one of them are returned — this both keeps the picker relevant and
   * drops claude-mem/observer noise (their cwd isn't a user workspace).
   * Empty/undefined roots = all history. `offset` is counted against *valid*
   * (surfaced) sessions, so the picker can request the next page by passing the
   * number of rows it already holds. `hasMore` is true when a further valid
   * session exists past this page.
   */
  listSessions(roots?: string[], opts?: { offset?: number; limit?: number }): SessionPage {
    const empty: SessionPage = { sessions: [], hasMore: false }
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
    // gather every session file with its mtime, newest first
    const files: { path: string; id: string; mtime: number }[] = []
    let projectDirs: string[] = []
    try {
      projectDirs = readdirSync(ROOT)
    } catch {
      return empty
    }
    for (const dir of projectDirs) {
      // skip hang4r's own worktree sessions — importing them is just noise
      if (dir.includes('hang4r-worktrees')) continue
      const full = join(ROOT, dir)
      let entries: string[] = []
      try {
        entries = readdirSync(full)
      } catch {
        continue
      }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue
        try {
          const p = join(full, f)
          files.push({ path: p, id: f.replace(/\.jsonl$/, ''), mtime: statSync(p).mtimeMs })
        } catch {
          /* ignore */
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)

    const out: ExternalSession[] = []
    let matched = 0 // valid sessions seen in order (for offset paging)
    let hasMore = false
    for (const file of files) {
      // cheap cwd peek from the file head → skip non-workspace files without a
      // full read (there can be thousands of claude-mem/observer transcripts)
      if (norm.length && !inRoots(peekCwd(file.path))) continue
      const parsed = this.summarize(file.path)
      if (!parsed || !inRoots(parsed.cwd)) continue
      // no real first prompt AND no custom name → agent/system transcript, drop it
      if (!parsed.title && !parsed.customName) continue
      // this is the (matched)-th valid session; skip those before the page
      if (matched >= offset) {
        if (out.length >= limit) {
          // a further valid session exists beyond this page
          hasMore = true
          break
        }
        out.push({
          id: file.id,
          name: parsed.title || parsed.customName || '',
          customName: parsed.customName,
          createdAt: parsed.createdAt || file.mtime,
          updatedAt: file.mtime,
          messageCount: parsed.count,
          cwd: parsed.cwd,
          lastMessage: parsed.lastMessage
        })
      }
      matched++
    }
    return { sessions: out, hasMore }
  },

  /** first user prompt (title) + custom name + last message + count + first ts + cwd */
  summarize(path: string): {
    title: string
    customName?: string
    count: number
    createdAt: number
    cwd?: string
    lastMessage?: string
  } | null {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    let title = ''
    let customName = ''
    let count = 0
    let createdAt = 0
    let cwd: string | undefined
    let lastMessage = ''
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let ev: {
        type?: string
        message?: { content?: unknown }
        timestamp?: string
        cwd?: string
        customTitle?: string
      }
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.cwd && !cwd) cwd = ev.cwd
      // Claude Code's /rename writes a `custom-title` event inline (repeated on
      // later events) — take the most recent one as the session's display name.
      if (ev.type === 'custom-title' && typeof ev.customTitle === 'string' && ev.customTitle.trim())
        customName = ev.customTitle.trim()
      if (ev.type === 'user' || ev.type === 'assistant') {
        count++
        if (!createdAt && ev.timestamp) createdAt = Date.parse(ev.timestamp) || 0
        const t = textOf(ev.message?.content).trim()
        if (!title && ev.type === 'user') {
          // background-agent / plugin sessions (claude-mem observers, etc.) aren't
          // the user's work — skip the whole session so real chats surface.
          if (NOISE.some((re) => re.test(t))) return null
          // skip continuation/system boilerplate for the TITLE, keep scanning.
          if (t && !t.startsWith('<') && !SKIP_TITLE.some((re) => re.test(t))) {
            title = t.replace(/\s+/g, ' ').slice(0, 80)
          }
        }
        // track the most recent meaningful message for the preview + search
        if (t && !t.startsWith('<')) lastMessage = t.replace(/\s+/g, ' ').slice(0, 160)
      }
    }
    if (count === 0) return null
    // title left empty on purpose = no meaningful user prompt; caller drops it
    // (unless a custom name is present, which the caller keeps)
    return { title, customName: customName || undefined, count, createdAt, cwd, lastMessage }
  },

  /** locate a session's jsonl file (id is unique across project dirs) */
  sessionFile(id: string): string | null {
    if (!existsSync(ROOT)) return null
    try {
      for (const dir of readdirSync(ROOT)) {
        const p = join(ROOT, dir, `${id}.jsonl`)
        if (existsSync(p)) return p
      }
    } catch {
      return null
    }
    return null
  },

  /**
   * Rewind anchor for "edit a sent message → restart from there": find the
   * user prompt matching `text`, counting `occurrenceFromEnd` identical
   * prompts AFTER it (from-the-end matching survives resumed sessions whose
   * older history isn't shown in hang4r), and return its parentUuid — the
   * message the fork should keep as its last (--resume-session-at is
   * truncate-inclusive).
   */
  findRewindAnchor(
    id: string,
    text: string,
    occurrenceFromEnd: number
  ): { parentUuid: string | null } | null {
    const path = this.sessionFile(id)
    if (!path) return null
    try {
      return parseRewindAnchor(readFileSync(path, 'utf8'), text, occurrenceFromEnd)
    } catch {
      return null
    }
  },

  /**
   * Transcript re-sync support: turns taken in an EXTERNAL interactive CLI
   * (e.g. the /remote-control terminal) land in a NEW session file — a fork
   * that contains the full history (same uuids) plus the new turns. hang4r
   * records a watermark (tail uuid) after each of its own turns; a newer file
   * containing that uuid is a continuation to import + adopt.
   */

  /** true if this session's jsonl ends mid-tool (aborted turn) — Claude can't
   *  --resume it, so we must fork-truncate past the poison before resuming */
  tailIsPoisoned(id: string): boolean {
    const path = this.sessionFile(id)
    if (!path) return false
    try {
      return hasDanglingToolUse(readFileSync(path, 'utf8'))
    } catch {
      return false
    }
  },

  /**
   * Repair a poisoned tail IN PLACE: append the missing tool_result(s) so
   * `claude --resume` accepts the file again, KEEPING the aborted turn (unlike
   * poisonRewindAnchor, which fork-truncates it away). Returns true if it healed
   * anything. Preferred over the fork anchor; the fork stays as a fallback when
   * this can't fix the file (e.g. can't locate it / write fails). Claude-only —
   * ssh transcripts aren't local, so sessionFile misses them and this no-ops.
   */
  healPoison(id: string): boolean {
    const path = this.sessionFile(id)
    if (!path) return false
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return false
    }
    const healed = healPoisonedTranscript(raw)
    if (healed === null) return false
    try {
      writeFileSync(path, healed)
    } catch {
      return false
    }
    return true
  },

  /** parentUuid to fork-truncate the poisoned turn out of this session's jsonl
   *  (targets the dangling tool_use directly, so retry prompts can't drift it);
   *  null if there's no poison or it can't be resolved (caller falls back) */
  poisonRewindAnchor(id: string): string | null {
    const path = this.sessionFile(id)
    if (!path) return null
    try {
      return parsePoisonAnchor(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  },

  /** uuid of the last line in a session's jsonl (the sync watermark) */
  tailUuid(id: string): string | null {
    const path = this.sessionFile(id)
    if (!path) return null
    let last: string | null = null
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        const m = /"uuid"\s*:\s*"([0-9a-fA-F-]{8,})"/.exec(line)
        if (m) last = m[1]
      }
    } catch {
      return null
    }
    return last
  },

  /** newest session file in cwd's project dir that contains `uuid` but isn't `excludeId` */
  findContinuation(cwd: string, uuid: string, excludeId: string): { id: string; path: string } | null {
    // Claude Code encodes the REALPATH (macOS: /var → /private/var) of the
    // project dir, replacing non-alphanumerics with '-'
    let real = cwd
    try {
      real = realpathSync(cwd)
    } catch {
      /* keep as-is */
    }
    const dir = join(ROOT, real.replace(/[^a-zA-Z0-9]/g, '-'))
    if (!existsSync(dir)) return null
    const needle = `"uuid":"${uuid}"`
    let best: { id: string; path: string; mtime: number } | null = null
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue
        const id = f.replace(/\.jsonl$/, '')
        if (id === excludeId) continue
        const p = join(dir, f)
        const mtime = statSync(p).mtimeMs
        if (best && mtime <= best.mtime) continue
        let raw: string
        try {
          raw = readFileSync(p, 'utf8')
        } catch {
          continue
        }
        if (raw.includes(needle)) best = { id, path: p, mtime }
      }
    } catch {
      return null
    }
    return best ? { id: best.id, path: best.path } : null
  },

  /** user/assistant messages strictly AFTER the line carrying `afterUuid` */
  messagesAfter(path: string, afterUuid: string): AfterMessage[] {
    try {
      return parseMessagesAfter(readFileSync(path, 'utf8'), afterUuid)
    } catch {
      return []
    }
  },

  /** genuinely-external turns only — drops our own just-ended turn (see filterExternalTurns) */
  filterExternalTurns,

  getTranscript(id: string): ExternalMessage[] {
    const path = this.sessionFile(id)
    if (!path) return []
    const msgs: ExternalMessage[] = []
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let ev: { type?: string; message?: { content?: unknown } }
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type !== 'user' && ev.type !== 'assistant') continue
        const text = textOf(ev.message?.content).trim()
        if (!text || text.startsWith('<')) continue
        msgs.push({ role: ev.type, text })
      }
    } catch {
      return []
    }
    return msgs
  }
}
