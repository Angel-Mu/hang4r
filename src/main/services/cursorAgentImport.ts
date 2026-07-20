import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Import + resume for the `cursor-agent` CLI (NOT the Cursor IDE — that's the
 * separate CursorImport / cursorTranscript surface reading the IDE's global DB).
 *
 * Storage (captured live, docs/cursor-agent-protocol.md):
 *   ~/.cursor/chats/<workspace-hash>/<chatId>/
 *       store.db   — SQLite. Tables:
 *                      meta(key TEXT PK, value)  — key '0' is a JSON blob
 *                        { agentId, latestRootBlobId, name, mode, createdAt }
 *                      blobs(id TEXT PK, data BLOB) — content-addressed nodes;
 *                        conversation messages are JSON blobs {role, content},
 *                        stitched into order by a binary (protobuf) root blob.
 *       meta.json  — sidecar { schemaVersion, createdAtMs, updatedAtMs, cwd,
 *                              hasConversation }.
 *
 * The ORDERED transcript lives elsewhere, as clean JSONL:
 *   ~/.cursor/projects/<project-slug>/agent-transcripts/<chatId>/<chatId>.jsonl
 *   lines: {role:'user'|'assistant', message:{content:[{type:'text',text}, …]}}
 *          and a trailing {type:'turn_ended', status}.
 * We prefer this for transcript + lastMessage (ordered); the store.db name is
 * the title, meta.json gives cwd/timestamps. Enumeration reads store.db per the
 * schema requirement, and the JSONL is a best-effort ordered overlay.
 */

const CHATS_ROOT = join(homedir(), '.cursor', 'chats')
const PROJECTS_ROOT = join(homedir(), '.cursor', 'projects')

export interface CursorAgentSession {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  messageCount: number
  cwd?: string
  lastMessage?: string
}

export interface CursorAgentSessionPage {
  sessions: CursorAgentSession[]
  hasMore: boolean
}

export interface CursorAgentMessage {
  role: 'user' | 'assistant'
  text: string
}

interface ChatMetaJson {
  createdAtMs?: number
  updatedAtMs?: number
  cwd?: string
  hasConversation?: boolean
}

/** meta.json sidecar in the chat dir (cwd + timestamps). */
function readChatMetaJson(chatDir: string): ChatMetaJson {
  try {
    return JSON.parse(readFileSync(join(chatDir, 'meta.json'), 'utf8')) as ChatMetaJson
  } catch {
    return {}
  }
}

/** The `name` (title) from store.db's meta['0'] JSON blob. */
function readStoreName(dbPath: string): string | undefined {
  if (!existsSync(dbPath)) return undefined
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as
      | { value: unknown }
      | undefined
    if (!row) return undefined
    const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value)
    const meta = JSON.parse(raw) as { name?: string }
    const name = meta.name?.trim()
    return name || undefined
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

/** Strip cursor's `<timestamp>…</timestamp>` / `<user_query>…</user_query>` wrappers. */
export function parseCursorUserText(text: string): string {
  const q = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  if (q) return q[1].trim()
  return text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '').trim()
}

function jsonlTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/** Parse an agent-transcript JSONL into ordered user/assistant messages. */
export function cursorTranscriptFromJsonl(raw: string): CursorAgentMessage[] {
  const out: CursorAgentMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row: { role?: string; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.role !== 'user' && row.role !== 'assistant') continue
    const text = jsonlTextBlocks(row.message?.content).trim()
    if (!text) continue
    out.push({
      role: row.role,
      text: row.role === 'user' ? parseCursorUserText(text) : text
    })
  }
  return out
}

/** Index chatId → agent-transcript JSONL path across all cursor projects. */
function transcriptIndex(): Map<string, string> {
  const index = new Map<string, string>()
  if (!existsSync(PROJECTS_ROOT)) return index
  let projects: string[]
  try {
    projects = readdirSync(PROJECTS_ROOT)
  } catch {
    return index
  }
  for (const project of projects) {
    const dir = join(PROJECTS_ROOT, project, 'agent-transcripts')
    let chatIds: string[]
    try {
      chatIds = readdirSync(dir)
    } catch {
      continue
    }
    for (const chatId of chatIds) {
      const jsonl = join(dir, chatId, `${chatId}.jsonl`)
      if (existsSync(jsonl)) index.set(chatId, jsonl)
    }
  }
  return index
}

function transcriptPath(chatId: string): string | null {
  return transcriptIndex().get(chatId) ?? null
}

export class CursorAgentImport {
  static available(): boolean {
    return existsSync(CHATS_ROOT)
  }

  /** Enumerate cursor-agent chats, newest first, filtered to `roots` if given. */
  static listSessions(
    roots?: string[],
    opts?: { offset?: number; limit?: number }
  ): CursorAgentSessionPage {
    const empty: CursorAgentSessionPage = { sessions: [], hasMore: false }
    if (!existsSync(CHATS_ROOT)) return empty
    const offset = Math.max(0, opts?.offset ?? 0)
    const limit = Math.max(1, opts?.limit ?? 100)
    const norm = (roots ?? []).map((r) => r.replace(/\/+$/, '')).filter(Boolean)
    const inRoots = (cwd?: string): boolean => {
      if (!norm.length) return true
      if (!cwd) return false
      const c = cwd.replace(/\/+$/, '')
      return norm.some((r) => c === r || c.startsWith(r + '/'))
    }

    // gather every chat dir (chats/<hash>/<chatId>/) with its store.db
    type Chat = { id: string; dir: string; db: string; mtime: number }
    const chats: Chat[] = []
    let hashDirs: string[]
    try {
      hashDirs = readdirSync(CHATS_ROOT)
    } catch {
      return empty
    }
    for (const hash of hashDirs) {
      const hashPath = join(CHATS_ROOT, hash)
      let chatIds: string[]
      try {
        if (!statSync(hashPath).isDirectory()) continue
        chatIds = readdirSync(hashPath)
      } catch {
        continue
      }
      for (const id of chatIds) {
        const dir = join(hashPath, id)
        const db = join(dir, 'store.db')
        if (!existsSync(db)) continue
        try {
          chats.push({ id, dir, db, mtime: statSync(db).mtimeMs })
        } catch {
          /* skip unreadable */
        }
      }
    }
    chats.sort((a, b) => b.mtime - a.mtime)

    const index = transcriptIndex()
    const sessions: CursorAgentSession[] = []
    let matched = 0
    let hasMore = false
    for (const chat of chats) {
      const meta = readChatMetaJson(chat.dir)
      if (meta.hasConversation === false) continue
      if (!inRoots(meta.cwd)) continue

      const jsonl = index.get(chat.id)
      let messages: CursorAgentMessage[] = []
      if (jsonl) {
        try {
          messages = cursorTranscriptFromJsonl(readFileSync(jsonl, 'utf8'))
        } catch {
          /* best effort */
        }
      }
      if (!messages.length) continue // nothing to show / resume

      if (matched >= offset) {
        if (sessions.length >= limit) {
          hasMore = true
          break
        }
        const firstUser = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').slice(0, 80)
        const lastMessage = messages[messages.length - 1]?.text.replace(/\s+/g, ' ').slice(0, 160)
        sessions.push({
          id: chat.id,
          name: readStoreName(chat.db) || firstUser || 'Cursor session',
          createdAt: meta.createdAtMs || chat.mtime,
          updatedAt: meta.updatedAtMs || chat.mtime,
          messageCount: messages.length,
          cwd: meta.cwd,
          lastMessage
        })
      }
      matched++
    }
    return { sessions, hasMore }
  }

  static getTranscript(chatId: string): CursorAgentMessage[] {
    const jsonl = transcriptPath(chatId)
    if (!jsonl) return []
    try {
      return cursorTranscriptFromJsonl(readFileSync(jsonl, 'utf8'))
    } catch {
      return []
    }
  }
}
