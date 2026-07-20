import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Read-only importer for Cursor's local chat history. Cursor stores composers
 * in a SQLite DB: the session list lives in ItemTable['composer.composerHeaders'],
 * each composer's metadata in cursorDiskKV['composerData:<id>'], and each message
 * ('bubble') in cursorDiskKV['bubbleId:<id>:<bubbleId>'] (type 1 = user, 2 =
 * assistant). Format is undocumented, so every access is defensive.
 *
 * Cursor doesn't record a composer's cwd with the composer itself, but each
 * per-workspace store (workspaceStorage/<hash>/) has a workspace.json → folder
 * and a state.vscdb whose composer.composerData.allComposers lists the composer
 * IDs opened there. We join those to give each session a workspace path.
 */
const DB_PATH = join(
  homedir(),
  'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
)
const WS_ROOT = join(homedir(), 'Library/Application Support/Cursor/User/workspaceStorage')

export interface CursorSession {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  messageCount: number
  cwd?: string
  lastMessage?: string
}

/** composerId → workspace folder path, from the per-workspace stores */
function workspaceMap(): Map<string, string> {
  const map = new Map<string, string>()
  let dirs: string[] = []
  try {
    dirs = readdirSync(WS_ROOT)
  } catch {
    return map
  }
  for (const d of dirs) {
    let folder: string | undefined
    try {
      const j = JSON.parse(readFileSync(join(WS_ROOT, d, 'workspace.json'), 'utf8'))
      if (typeof j.folder === 'string') folder = decodeURIComponent(j.folder.replace(/^file:\/\//, ''))
    } catch {
      continue
    }
    if (!folder) continue
    const dbPath = join(WS_ROOT, d, 'state.vscdb')
    if (!existsSync(dbPath)) continue
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value?: string } | undefined
      db.close()
      if (!row?.value) continue
      const all = (JSON.parse(row.value).allComposers ?? []) as { composerId?: string }[]
      for (const c of all) if (c.composerId) map.set(c.composerId, folder!)
    } catch {
      /* skip unreadable workspace db */
    }
  }
  return map
}

export interface CursorMessage {
  role: 'user' | 'assistant'
  text: string
}

function open(): Database.Database | null {
  if (!existsSync(DB_PATH)) return null
  try {
    return new Database(DB_PATH, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
}

export const CursorImport = {
  /**
   * Availability probe must NOT touch Cursor's data container: macOS 15+
   * fires the scary "hang4r would like to access data from other apps"
   * prompt on ANY access to another app's Application Support dir — and this
   * probe used to run at every launch (Sidebar mount), so users with Cursor
   * installed got the prompt before doing anything. Checking for the app
   * BUNDLE is TCC-free; the DB is only opened when the user opens the Import
   * dialog's Cursor tab — a consented, contextual moment for the prompt.
   */
  available(): boolean {
    return (
      existsSync('/Applications/Cursor.app') ||
      existsSync(join(homedir(), 'Applications/Cursor.app'))
    )
  },

  /**
   * Recent Cursor composer sessions. Each is tagged with its workspace folder
   * (via workspaceMap) + a last-message preview; if `roots` is given, only
   * sessions inside those workspaces are returned.
   */
  listSessions(roots?: string[], limit = 80): CursorSession[] {
    const db = open()
    if (!db) return []
    const norm = (roots ?? []).map((r) => r.replace(/\/+$/, '')).filter(Boolean)
    const inRoots = (cwd?: string): boolean => {
      if (!norm.length) return true
      if (!cwd) return false
      const c = cwd.replace(/\/+$/, '')
      return norm.some((r) => c === r || c.startsWith(r + '/'))
    }
    const wsMap = workspaceMap()
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
        .get() as { value?: string } | undefined
      if (!row?.value) return []
      let heads: Array<{ composerId: string; createdAt?: number; lastUpdatedAt?: number }> = []
      try {
        heads = (JSON.parse(row.value).allComposers ?? []) as typeof heads
      } catch {
        return []
      }
      heads.sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0))
      const stmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      const out: CursorSession[] = []
      let scanned = 0
      for (const h of heads) {
        if (out.length >= limit || scanned >= 800) break
        const dataRow = stmt.get(`composerData:${h.composerId}`) as { value?: string } | undefined
        if (!dataRow?.value) continue
        scanned++
        let data: {
          name?: string
          createdAt?: number
          lastUpdatedAt?: number
          fullConversationHeadersOnly?: { bubbleId: string; type: number }[]
        }
        try {
          data = JSON.parse(dataRow.value)
        } catch {
          continue
        }
        const headers = Array.isArray(data.fullConversationHeadersOnly)
          ? data.fullConversationHeadersOnly
          : []
        if (headers.length === 0) continue // skip empty/draft composers
        // cwd: the recently-open workspace map (fast path), else any added
        // workspace whose files this session referenced (covers history)
        let cwd = wsMap.get(h.composerId)
        if (!cwd && norm.length) cwd = norm.find((r) => dataRow.value!.includes(r + '/'))
        if (!inRoots(cwd)) continue
        // last-message preview (for the picker + search)
        let lastMessage: string | undefined
        for (let i = headers.length - 1; i >= 0 && !lastMessage; i--) {
          const bRow = stmt.get(`bubbleId:${h.composerId}:${headers[i].bubbleId}`) as
            | { value?: string }
            | undefined
          if (!bRow?.value) continue
          try {
            const t = String(JSON.parse(bRow.value).text ?? '').replace(/\s+/g, ' ').trim()
            if (t) lastMessage = t.slice(0, 160)
          } catch {
            /* skip */
          }
        }
        out.push({
          id: h.composerId,
          name: (data.name ?? '').trim() || 'Untitled Cursor chat',
          createdAt: data.createdAt ?? h.createdAt ?? 0,
          updatedAt: data.lastUpdatedAt ?? h.lastUpdatedAt ?? 0,
          messageCount: headers.length,
          cwd,
          lastMessage
        })
      }
      return out
    } catch {
      return []
    } finally {
      db.close()
    }
  },

  /** Ordered user/assistant messages for one composer. */
  getTranscript(composerId: string): CursorMessage[] {
    const db = open()
    if (!db) return []
    try {
      const dataRow = db
        .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
        .get(`composerData:${composerId}`) as { value?: string } | undefined
      if (!dataRow?.value) return []
      let headers: Array<{ bubbleId: string; type: number }> = []
      try {
        headers = JSON.parse(dataRow.value).fullConversationHeadersOnly ?? []
      } catch {
        return []
      }
      const stmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      const msgs: CursorMessage[] = []
      for (const h of headers) {
        const bRow = stmt.get(`bubbleId:${composerId}:${h.bubbleId}`) as
          | { value?: string }
          | undefined
        if (!bRow?.value) continue
        try {
          const b = JSON.parse(bRow.value)
          const text = String(b.text ?? '').trim()
          if (!text) continue
          msgs.push({ role: h.type === 1 ? 'user' : 'assistant', text })
        } catch {
          /* skip malformed bubble */
        }
      }
      return msgs
    } catch {
      return []
    } finally {
      db.close()
    }
  }
}
