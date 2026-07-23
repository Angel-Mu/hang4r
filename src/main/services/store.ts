import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  AgentEvent,
  BackendId,
  EnvironmentKind,
  PermissionMode,
  Project,
  SessionEvent,
  SessionMeta,
  SessionStatus
} from '../../shared/protocol'

/**
 * App-owned persistence (SQLite). We never write into ~/.claude — Claude's
 * JSONL session files stay Claude's; we only store our own metadata and a
 * replayable transcript of translated agent events.
 */
export class Store {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        backend TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        backend_session_id TEXT,
        model TEXT,
        cwd TEXT NOT NULL,
        environment TEXT NOT NULL DEFAULT 'local',
        base_ref TEXT NOT NULL DEFAULT 'HEAD',
        permission_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        last_error TEXT,
        worktree_dropped INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        ts INTEGER NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session
        ON session_events(session_id, id);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    // Additive migrations for DBs created before these columns existed
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
        (c) => c.name
      )
    )
    if (!cols.has('environment')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN environment TEXT NOT NULL DEFAULT 'local'")
    }
    if (!cols.has('base_ref')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN base_ref TEXT NOT NULL DEFAULT 'HEAD'")
    }
    if (!cols.has('remote_host_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN remote_host_id TEXT')
    }
    if (!cols.has('worktree_dropped')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN worktree_dropped INTEGER NOT NULL DEFAULT 0')
    }
  }

  /* ---------- projects ---------- */

  createProject(path: string): Project {
    const existing = this.db
      .prepare('SELECT * FROM projects WHERE path = ?')
      .get(path) as ProjectRow | undefined
    if (existing) return rowToProject(existing)
    const project: Project = {
      id: randomUUID(),
      name: basename(path),
      path,
      createdAt: Date.now()
    }
    this.db
      .prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, project.name, project.path, project.createdAt)
    return project
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[]).map(
      rowToProject
    )
  }

  /** Remove a workspace from hang4r. Does NOT touch the folder on disk, nor its
   *  sessions' worktrees — only forgets the project + its settings. Callers
   *  should archive live sessions first. */
  removeProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    return row ? rowToProject(row) : undefined
  }

  /* ---------- sessions ---------- */

  createSession(opts: {
    projectId: string
    backend: BackendId
    title: string
    model?: string
    cwd: string
    environment: EnvironmentKind
    baseRef: string
    permissionMode: PermissionMode
    remoteHostId?: string
  }): SessionMeta {
    const now = Date.now()
    const session: SessionMeta = {
      id: randomUUID(),
      projectId: opts.projectId,
      backend: opts.backend,
      title: opts.title,
      status: 'starting',
      backendSessionId: null,
      model: opts.model ?? null,
      cwd: opts.cwd,
      environment: opts.environment,
      baseRef: opts.baseRef,
      permissionMode: opts.permissionMode,
      remoteHostId: opts.remoteHostId ?? null,
      createdAt: now,
      updatedAt: now,
      totalCostUsd: 0,
      lastError: null
    }
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, project_id, backend, title, status, backend_session_id, model, cwd,
          environment, base_ref, permission_mode, remote_host_id, created_at,
          updated_at, total_cost_usd, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.projectId,
        session.backend,
        session.title,
        session.status,
        session.backendSessionId,
        session.model,
        session.cwd,
        session.environment,
        session.baseRef,
        session.permissionMode,
        session.remoteHostId,
        session.createdAt,
        session.updatedAt,
        session.totalCostUsd,
        session.lastError
      )
    return session
  }

  updateSession(
    id: string,
    patch: Partial<
      Pick<
        SessionMeta,
        | 'status'
        | 'backendSessionId'
        | 'model'
        | 'title'
        | 'totalCostUsd'
        | 'lastError'
        | 'permissionMode'
        | 'worktreeDropped'
      >
    >
  ): SessionMeta | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    if (!row) return undefined
    const merged = { ...rowToSession(row), ...patch, updatedAt: Date.now() }
    this.db
      .prepare(
        `UPDATE sessions SET status=?, backend_session_id=?, model=?, title=?,
         total_cost_usd=?, last_error=?, permission_mode=?, worktree_dropped=?, updated_at=? WHERE id=?`
      )
      .run(
        merged.status,
        merged.backendSessionId,
        merged.model,
        merged.title,
        merged.totalCostUsd,
        merged.lastError,
        merged.permissionMode,
        merged.worktreeDropped ? 1 : 0,
        merged.updatedAt,
        id
      )
    return merged
  }

  setSessionWorkdir(id: string, cwd: string, baseRef: string): void {
    this.db
      .prepare('UPDATE sessions SET cwd=?, base_ref=?, updated_at=? WHERE id=?')
      .run(cwd, baseRef, Date.now(), id)
  }

  listSessions(): SessionMeta[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions WHERE status != 'archived' ORDER BY created_at")
        .all() as SessionRow[]
    ).map(rowToSession)
  }

  listArchivedSessions(): SessionMeta[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions WHERE status = 'archived' ORDER BY updated_at DESC")
        .all() as SessionRow[]
    ).map(rowToSession)
  }

  getSession(id: string): SessionMeta | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    return row ? rowToSession(row) : undefined
  }

  /* ---------- transcript events ---------- */

  appendEvent(sessionId: string, event: AgentEvent): SessionEvent {
    const ts = Date.now()
    const res = this.db
      .prepare('INSERT INTO session_events (session_id, ts, event_json) VALUES (?, ?, ?)')
      .run(sessionId, ts, JSON.stringify(event))
    return { sessionId, seq: Number(res.lastInsertRowid), ts, event }
  }

  /** Copy a session's transcript to another session (used by duplicate/fork). */
  copyEvents(fromSessionId: string, toSessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO session_events (session_id, ts, event_json)
         SELECT ?, ts, event_json FROM session_events WHERE session_id = ? ORDER BY id`
      )
      .run(toSessionId, fromSessionId)
  }

  /** Delete a session's events from seq `fromSeq` (inclusive) onward — rewind. */
  deleteEventsFrom(sessionId: string, fromSeq: number): void {
    this.db
      .prepare('DELETE FROM session_events WHERE session_id = ? AND id >= ?')
      .run(sessionId, fromSeq)
  }

  getEvents(sessionId: string): SessionEvent[] {
    return (
      this.db
        .prepare('SELECT id, ts, event_json FROM session_events WHERE session_id = ? ORDER BY id')
        .all(sessionId) as { id: number; ts: number; event_json: string }[]
    ).map((r) => ({ sessionId, seq: r.id, ts: r.ts, event: JSON.parse(r.event_json) }))
  }

  /* ---------- settings ---------- */

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, value)
  }
}

/* ---------- row mapping ---------- */

interface ProjectRow {
  id: string
  name: string
  path: string
  created_at: number
}
interface SessionRow {
  id: string
  project_id: string
  backend: string
  title: string
  status: string
  backend_session_id: string | null
  model: string | null
  cwd: string
  environment: string
  base_ref: string
  permission_mode: string
  remote_host_id: string | null
  created_at: number
  updated_at: number
  total_cost_usd: number
  last_error: string | null
  worktree_dropped: number
}

function rowToProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, path: r.path, createdAt: r.created_at }
}

function rowToSession(r: SessionRow): SessionMeta {
  return {
    id: r.id,
    projectId: r.project_id,
    backend: r.backend as BackendId,
    title: r.title,
    status: r.status as SessionStatus,
    backendSessionId: r.backend_session_id,
    model: r.model,
    cwd: r.cwd,
    environment: r.environment as EnvironmentKind,
    baseRef: r.base_ref,
    permissionMode: r.permission_mode as PermissionMode,
    remoteHostId: r.remote_host_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    totalCostUsd: r.total_cost_usd,
    lastError: r.last_error,
    worktreeDropped: !!r.worktree_dropped
  }
}
