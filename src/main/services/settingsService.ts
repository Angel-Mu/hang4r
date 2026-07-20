import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { join, dirname } from 'node:path'
import type { Store } from './store'
import { stripJsonComments, patchJsonc } from '../../shared/jsonc'

/**
 * File-backed settings (VS Code style). Two JSON files own the user-facing
 * config; the SQLite settings table keeps only internal/UI state.
 *
 *   ~/.hang4r/settings.json                — app-global user settings
 *   <projectPath>/.hang4r/settings.json    — per-workspace overrides (versionable)
 *
 * Precedence for a resolved value: workspace → app → SQLite (legacy fallback)
 * → built-in default. The renderer's getSetting/setSetting IPC keeps its flat
 * (key, value) shape — this service parses each key, routes it to the right
 * file (or the DB for internal state), and codecs between the string world of
 * the IPC and the file's native JSON types.
 *
 * External edits to either file live-reload: we fs.watch both, debounce, and
 * broadcast a `settings-changed` event so open UI reflects hand-edits.
 */

type Codec = 'str' | 'num' | 'bool' | 'json'

interface KeySpec {
  /** JSON path within the file (dotted for nesting, e.g. `binaries.claude`) */
  path: string
  codec: Codec
  /** whether a `:projectId` suffix routes this key to a workspace file */
  workspaceScoped: boolean
}

/**
 * The user-setting keys that live in the files. Everything NOT listed here
 * (layout, sidebarWidth, pinned*, projectOrder/Sort, usage caches, effort:*,
 * sessionInitV1:*, syncWatermark:*, collapsed flags, …) is internal state and
 * stays in SQLite untouched.
 */
const USER_KEYS: Record<string, KeySpec> = {
  theme: { path: 'theme', codec: 'str', workspaceScoped: false },
  editorFontSize: { path: 'editorFontSize', codec: 'num', workspaceScoped: false },
  chatFontSize: { path: 'chatFontSize', codec: 'num', workspaceScoped: false },
  terminalShell: { path: 'terminalShell', codec: 'str', workspaceScoped: true },
  terminalKeymap: { path: 'terminalKeymap', codec: 'json', workspaceScoped: false },
  notifyOnComplete: { path: 'notifyOnComplete', codec: 'bool', workspaceScoped: false },
  'notifications.onActionRequired': {
    path: 'notifications.onActionRequired',
    codec: 'bool',
    workspaceScoped: true
  },
  'notifications.onError': { path: 'notifications.onError', codec: 'bool', workspaceScoped: true },
  defaultModel: { path: 'defaultModel', codec: 'str', workspaceScoped: false },
  defaultPermissionMode: { path: 'defaultPermissionMode', codec: 'str', workspaceScoped: false },
  defaultEnvironment: { path: 'defaultEnvironment', codec: 'str', workspaceScoped: false },
  claudeBinaryPath: { path: 'binaries.claude', codec: 'str', workspaceScoped: false },
  codexBinaryPath: { path: 'binaries.codex', codec: 'str', workspaceScoped: false },
  cursorBinaryPath: { path: 'binaries.cursor', codec: 'str', workspaceScoped: false },
  sshHosts: { path: 'sshHosts', codec: 'json', workspaceScoped: false },
  worktreeDir: { path: 'worktreeDir', codec: 'str', workspaceScoped: true },
  worktreeBranchPrefix: { path: 'worktreeBranchPrefix', codec: 'str', workspaceScoped: true },
  setupScript: { path: 'setupScript', codec: 'str', workspaceScoped: true },
  devProcesses: { path: 'devProcesses', codec: 'json', workspaceScoped: true }
}

type JsonObj = Record<string, unknown>

interface Route {
  file: string
  spec: KeySpec
  /** the original flat key, used for the legacy DB fallback */
  dbKey: string
}

export type SettingsChangeScope = 'app' | 'workspace'

export class SettingsService {
  private watchers: FSWatcher[] = []
  /** content we just wrote — lets the watcher ignore our own writes */
  private selfWrites = new Map<string, string>()
  private broadcast: (scope: SettingsChangeScope) => void

  constructor(
    private store: Store,
    /** the ~/.hang4r directory (overridden to a temp dir under test) */
    private appDir: string,
    broadcast?: (scope: SettingsChangeScope) => void
  ) {
    this.broadcast = broadcast ?? ((): void => {})
    this.migrate()
    this.startWatching()
  }

  /* ---------- paths ---------- */

  private get appFile(): string {
    return join(this.appDir, 'settings.json')
  }

  private workspaceFile(projectId: string): string | null {
    const project = this.store.getProject(projectId)
    if (!project) return null
    return join(project.path, '.hang4r', 'settings.json')
  }

  /* ---------- routing ---------- */

  /** Split a flat key into its base and optional `:suffix` (projectId/sessionId). */
  private parse(key: string): { base: string; suffix: string | null } {
    const i = key.indexOf(':')
    if (i === -1) return { base: key, suffix: null }
    return { base: key.slice(0, i), suffix: key.slice(i + 1) }
  }

  /** Resolve a flat key to a file route, or null when it's internal DB state. */
  private route(key: string): Route | null {
    const { base, suffix } = this.parse(key)
    const spec = USER_KEYS[base]
    if (!spec) return null // internal → DB
    if (suffix) {
      // a suffixed user key is a per-workspace override (worktreeDir:projectId, …)
      if (!spec.workspaceScoped) return null // suffix on an app-only key → treat as DB
      const file = this.workspaceFile(suffix)
      if (!file) return null // unknown project → DB fallback
      return { file, spec, dbKey: key }
    }
    return { file: this.appFile, spec, dbKey: key }
  }

  /* ---------- public IPC surface (mirrors Store.getSetting/setSetting) ---------- */

  getSetting(key: string): string | null {
    const route = this.route(key)
    if (!route) return this.store.getSetting(key)
    const obj = this.readFile(route.file)
    const raw = getAtPath(obj, route.spec.path)
    if (raw === undefined) return this.store.getSetting(route.dbKey) // legacy fallback
    return decode(raw, route.spec.codec)
  }

  setSetting(key: string, value: string): void {
    const route = this.route(key)
    if (!route) {
      this.store.setSetting(key, value)
      return
    }
    const encoded = encode(value, route.spec.codec)

    // Absent file: no comments to preserve — write a fresh pretty-printed object.
    if (!existsSync(route.file)) {
      const obj: JsonObj = {}
      setAtPath(obj, route.spec.path, encoded)
      this.writeFile(route.file, obj)
      return
    }

    // Present file: patch the raw text in place so the user's comments survive.
    // readFileForWrite throws "Refusing to save" on a malformed file (never
    // clobbering it); we then splice with patchJsonc rather than stringify.
    this.readFileForWrite(route.file) // guard only — throws on malformed
    const text = readFileSync(route.file, 'utf8')
    let patched: string
    try {
      patched = patchJsonc(text, route.spec.path.split('.'), encoded)
      const check = JSON.parse(stripJsonComments(patched))
      if (!check || typeof check !== 'object') throw new Error('patched text is not a JSON object')
    } catch (e) {
      throw new Error(
        `Refusing to save: could not update ${route.file} while preserving its comments ` +
          `(${e instanceof Error ? e.message : String(e)}). Your file was left unchanged — ` +
          `edit it directly (Settings → settings.json) and retry.`
      )
    }
    this.writeText(route.file, patched)
  }

  /**
   * Typed resolution honouring workspace → app precedence for a base key, even
   * when the caller can only supply a projectId out-of-band (e.g. the terminal
   * resolving its shell for a session's workspace).
   */
  resolve(baseKey: string, projectId?: string): string | null {
    const spec = USER_KEYS[baseKey]
    if (!spec) return this.getSetting(baseKey)
    if (projectId && spec.workspaceScoped) {
      const ws = this.getSetting(`${baseKey}:${projectId}`)
      if (ws !== null && ws !== '') return ws
    }
    return this.getSetting(baseKey)
  }

  /**
   * A per-backend agent default (agents.<backend>.<field>), workspace over app.
   * Hand-edited in the settings.json files (no dedicated UI writer); read by
   * the New Agent dialog via the `settings:resolve-agent-default` IPC to
   * pre-fill model + permission mode for the selected backend/workspace.
   */
  resolveAgentDefault(
    backend: string,
    field: string,
    projectId?: string
  ): string | null {
    const read = (file: string): string | null => {
      const obj = this.readFile(file)
      const v = getAtPath(obj, `agents.${backend}.${field}`)
      return v === undefined || v === null ? null : String(v)
    }
    if (projectId) {
      const wf = this.workspaceFile(projectId)
      if (wf) {
        const v = read(wf)
        if (v !== null && v !== '') return v
      }
    }
    return read(this.appFile)
  }

  /* ---------- raw file access (in-app JSON editor) ---------- */

  /** Absolute path of a scope's settings file (workspace needs a projectId). */
  filePath(scope: SettingsChangeScope, projectId?: string): string | null {
    if (scope === 'app') return this.appFile
    return projectId ? this.workspaceFile(projectId) : null
  }

  /** Raw text of a settings file (or a pretty empty object when absent). */
  readRaw(scope: SettingsChangeScope, projectId?: string): string {
    const file = this.filePath(scope, projectId)
    if (!file || !existsSync(file)) return '{}\n'
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return '{}\n'
    }
  }

  /** Overwrite a settings file with raw text after validating it parses. */
  writeRaw(scope: SettingsChangeScope, text: string, projectId?: string): void {
    const file = this.filePath(scope, projectId)
    if (!file) throw new Error('No settings file for that scope.')
    // validate against the comment-stripped text (files tolerate JSONC); the
    // raw text — comments and all — is what actually lands on disk.
    JSON.parse(stripJsonComments(text)) // throws on invalid JSON — caller surfaces the message
    mkdirSync(dirname(file), { recursive: true })
    this.selfWrites.set(file, text)
    writeFileSync(file, text)
  }

  /* ---------- file helpers ---------- */

  private readFile(file: string): JsonObj | null {
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')))
      return parsed && typeof parsed === 'object' ? (parsed as JsonObj) : null
    } catch {
      return null // malformed file → reads fall back as if empty
    }
  }

  /** Like readFile, but distinguishes "absent" ({} is a fine base for writes)
   *  from "present but unparseable" (throws — a write starting from {} would
   *  silently destroy every other setting in the file; QA hunt #11's data-loss
   *  finding). */
  private readFileForWrite(file: string): JsonObj {
    if (!existsSync(file)) return {}
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      throw new Error(`Cannot read ${file}: ${String(e)}`)
    }
    try {
      const parsed = JSON.parse(stripJsonComments(text))
      if (parsed && typeof parsed === 'object') return parsed as JsonObj
      throw new Error('not a JSON object')
    } catch (e) {
      throw new Error(
        `Refusing to save: ${file} exists but isn't valid JSON(C) (${
          e instanceof SyntaxError ? e.message : String(e)
        }). Fix the file (Settings → settings.json) or delete it, then retry — ` +
          `overwriting now would silently discard your other settings in that file.`
      )
    }
  }

  private writeFile(file: string, obj: JsonObj): void {
    this.writeText(file, JSON.stringify(obj, null, 2) + '\n')
  }

  /** Write raw text and register it as a self-write so the watcher ignores it. */
  private writeText(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true })
    this.selfWrites.set(file, text)
    writeFileSync(file, text)
  }

  /* ---------- migration ---------- */

  /**
   * One-time export of the classified user-setting keys from SQLite into the
   * files. Idempotent: skips a file that already exists. DB values are left in
   * place as the fallback — nothing is ever destroyed.
   */
  private migrate(): void {
    if (!existsSync(this.appFile)) {
      const obj: JsonObj = {}
      for (const [base, spec] of Object.entries(USER_KEYS)) {
        if (spec.workspaceScoped && base !== 'worktreeDir' && base !== 'setupScript') continue
        const v = this.store.getSetting(base)
        if (v === null) continue
        setAtPath(obj, spec.path, encode(v, spec.codec))
      }
      // self-documenting scaffold for the forward-looking per-backend defaults
      if (!('agents' in obj)) obj.agents = { claude: {}, codex: {}, cursor: {} }
      this.writeFile(this.appFile, obj)
    }
    // per-workspace migration for known projects (best effort)
    for (const project of this.store.listProjects()) {
      const file = this.workspaceFile(project.id)
      if (!file || existsSync(file)) continue
      const obj: JsonObj = {}
      let any = false
      for (const base of ['worktreeDir', 'setupScript', 'devProcesses'] as const) {
        const v = this.store.getSetting(`${base}:${project.id}`)
        if (v === null) continue
        setAtPath(obj, USER_KEYS[base].path, encode(v, USER_KEYS[base].codec))
        any = true
      }
      if (any) this.writeFile(file, obj)
    }
  }

  /* ---------- live reload ---------- */

  private startWatching(): void {
    // watch the app config dir (editors replace files via rename, so watching
    // the dir is more reliable than watching the file inode)
    this.watchDir(this.appDir, 'app')
    for (const project of this.store.listProjects()) {
      this.watchDir(join(project.path, '.hang4r'), 'workspace')
    }
  }

  /** Begin watching a project's .hang4r dir (called when a project is added). */
  watchProject(projectId: string): void {
    const project = this.store.getProject(projectId)
    if (project) this.watchDir(join(project.path, '.hang4r'), 'workspace')
  }

  private watchedDirs = new Set<string>()
  private debounce = new Map<string, NodeJS.Timeout>()

  private watchDir(dir: string, scope: SettingsChangeScope): void {
    if (this.watchedDirs.has(dir)) return
    try {
      mkdirSync(dir, { recursive: true })
      const w = watch(dir, (_event, filename) => {
        if (filename && filename !== 'settings.json') return
        const file = join(dir, 'settings.json')
        // ignore the echo of our own writes
        if (existsSync(file)) {
          try {
            if (this.selfWrites.get(file) === readFileSync(file, 'utf8')) return
          } catch {
            /* fallthrough → broadcast */
          }
        }
        const prev = this.debounce.get(dir)
        if (prev) clearTimeout(prev)
        this.debounce.set(
          dir,
          setTimeout(() => this.broadcast(scope), 150)
        )
      })
      this.watchers.push(w)
      this.watchedDirs.add(dir)
    } catch {
      /* watching is best effort — hand-edits just won't live-reload */
    }
  }

  dispose(): void {
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        /* ignore */
      }
    }
    this.watchers = []
  }
}

/* ---------- codecs & dotted-path helpers ---------- */

function decode(raw: unknown, codec: Codec): string {
  switch (codec) {
    case 'num':
      return String(raw)
    case 'bool':
      return raw ? 'on' : 'off'
    case 'json':
      return JSON.stringify(raw)
    default:
      return typeof raw === 'string' ? raw : String(raw)
  }
}

function encode(value: string, codec: Codec): unknown {
  switch (codec) {
    case 'num': {
      const n = Number(value)
      return Number.isFinite(n) ? n : value
    }
    case 'bool':
      return value !== 'off'
    case 'json':
      try {
        return JSON.parse(value)
      } catch {
        return value // keep raw rather than lose data
      }
    default:
      return value
  }
}

function getAtPath(obj: JsonObj | null, path: string): unknown {
  if (!obj) return undefined
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as JsonObj)[p]
    if (cur === undefined) return undefined
  }
  return cur
}

function setAtPath(obj: JsonObj, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: JsonObj = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p] as JsonObj
  }
  cur[parts[parts.length - 1]] = value
}
