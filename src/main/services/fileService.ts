import { readdir, readFile, stat, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, normalize, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { DirEntry } from '../../shared/protocol'
import { shellQuote, type Exec } from './remoteService'

const exec = promisify(execFile)

/** How a remote (ssh) call runs: the branch is explicit, not a plain Exec. */
type Remote = { exec: Exec }

/**
 * Validate + normalize a caller-supplied relative path for remote shell use.
 * Mirrors safeJoin's guarantee (no escaping the workspace root): rejects
 * absolute paths and any `..` segment. Returns a forward-slash relative path.
 */
function safeRel(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (norm.startsWith('/')) throw new Error('path escapes project root')
  if (norm.split('/').some((seg) => seg === '..')) throw new Error('path escapes project root')
  return norm
}

/** Directories the flat ⌘P list / search never DESCEND into — huge or noisy. */
const SKIP = new Set(['.git', 'node_modules', '.hang4r-worktrees', '.worktrees', '.DS_Store'])
/**
 * Entries hidden from the BROWSE tree — internals only. node_modules stays
 * VISIBLE here (hiding it made "did my install actually run?" unanswerable
 * from the explorer); ⌘P and search still skip its contents via SKIP.
 * The worktree containers stay hidden so a main-repo session doesn't nest
 * every agent's worktree inside its own tree.
 */
const HIDE_BROWSE = new Set(['.git', '.DS_Store', '.hang4r-worktrees', '.worktrees'])
const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Read-only file browsing scoped to a session's working directory. All paths
 * are relative to the root; we refuse to escape it (no `..` traversal).
 */
export const FileService = {
  async listDir(root: string, relPath: string, remote?: Remote): Promise<DirEntry[]> {
    if (remote) return listDirRemote(root, relPath, remote)
    const dir = safeJoin(root, relPath)
    let names: Dirent[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      // directory gone (e.g. a worktree that was cleaned up) — don't crash the UI
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const entries: DirEntry[] = []
    for (const d of names) {
      if (HIDE_BROWSE.has(d.name)) continue
      const childRel = relPath ? `${relPath}/${d.name}` : d.name
      entries.push({ name: d.name, path: childRel, isDir: d.isDirectory() })
    }
    return entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  },

  async readFile(
    root: string,
    relPath: string,
    remote?: Remote
  ): Promise<{ content: string; truncated: boolean }> {
    if (remote) {
      const rel = safeRel(relPath)
      const { stdout } = await remote.exec.run('cat', [rel], { cwd: root })
      if (Buffer.byteLength(stdout, 'utf8') > MAX_FILE_BYTES) {
        return {
          content: Buffer.from(stdout, 'utf8').subarray(0, MAX_FILE_BYTES).toString('utf8'),
          truncated: true
        }
      }
      return { content: stdout, truncated: false }
    }
    const file = safeJoin(root, relPath)
    const s = await stat(file)
    if (s.size > MAX_FILE_BYTES) {
      const buf = await readFile(file)
      return { content: buf.subarray(0, MAX_FILE_BYTES).toString('utf8'), truncated: true }
    }
    return { content: await readFile(file, 'utf8'), truncated: false }
  },

  async writeFile(root: string, relPath: string, content: string, remote?: Remote): Promise<void> {
    if (remote) {
      const rel = safeRel(relPath)
      // base64 round-trip: binary-safe, no stdin needed, no shell-quoting pitfalls
      const b64 = Buffer.from(content, 'utf8').toString('base64')
      const cmd = `printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(rel)}`
      await remote.exec.run('sh', ['-c', cmd], { cwd: root })
      return
    }
    const file = safeJoin(root, relPath)
    await writeFile(file, content, 'utf8')
  },

  /**
   * Tail an ABSOLUTE file path (a background task's output log lives outside the
   * worktree, e.g. /tmp/claude-…). Returns the last ~16KB. Read-only, best-effort.
   */
  async tailFile(absPath: string, maxBytes = 16 * 1024, remote?: Remote): Promise<string> {
    if (remote) return '' // background-task logs are a local-only concern in v1
    try {
      const buf = await readFile(absPath)
      return buf.length > maxBytes ? buf.subarray(buf.length - maxBytes).toString('utf8') : buf.toString('utf8')
    } catch {
      return ''
    }
  },

  /**
   * Content search-in-files. Uses `git grep` (fast, respects .gitignore, covers
   * tracked + untracked) inside the worktree; returns up to `max` matches.
   */
  async searchContent(
    root: string,
    query: string,
    max = 300,
    remote?: Remote
  ): Promise<{ path: string; line: number; text: string }[]> {
    if (remote) return [] // search-in-files not yet available on SSH sessions (docs/ssh-design.md)
    if (!query.trim()) return []
    const results: { path: string; line: number; text: string }[] = []
    try {
      const { stdout } = await exec(
        'git',
        [
          'grep',
          '--no-color',
          '-n', // line numbers
          '-I', // skip binary
          '--untracked', // include new files
          '--fixed-strings',
          '--ignore-case',
          '-e',
          query
        ],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 }
      ).catch((e: { stdout?: string; code?: number }) => ({ stdout: e.stdout ?? '' }))
      for (const raw of stdout.split('\n')) {
        if (!raw || results.length >= max) break
        // format: <path>:<line>:<text>
        const m = /^(.+?):(\d+):(.*)$/.exec(raw)
        if (m) results.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 300) })
      }
    } catch {
      /* not a repo / grep failed — empty */
    }
    return results
  },

  /**
   * Go-to-definition: find where `symbol` is defined across the worktree using
   * git grep with definition-shaped patterns (declarations, exports, defs).
   * Returns the best match's path + 1-based line, or null.
   */
  async findDefinition(
    root: string,
    symbol: string,
    remote?: Remote
  ): Promise<{ path: string; line: number } | null> {
    if (remote) return null // go-to-definition search not yet available on SSH sessions
    if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return null
    // git grep uses POSIX ERE (-E): no \s or \b — use [[:space:]] + explicit
    // non-word boundaries. Ordered by how definitive the pattern is.
    const b = '([^A-Za-z0-9_$]|$)' // trailing word boundary
    const patterns = [
      `(function|class|interface|type|enum|struct|trait)[[:space:]]+${symbol}${b}`,
      `(const|let|var)[[:space:]]+${symbol}${b}`,
      `${symbol}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function|\\()`, // foo: () =>, foo = function
      `(export|public|private|func|def|fn)[[:space:]].*${symbol}${b}`,
      `${symbol}[[:space:]]*\\(` // last resort: a def/call site
    ]
    for (const pat of patterns) {
      const { stdout } = await exec(
        'git',
        ['grep', '--no-color', '-n', '-E', '-I', '--untracked', '-e', pat],
        { cwd: root, maxBuffer: 8 * 1024 * 1024 }
      ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }))
      const first = stdout.split('\n').find((l) => l.trim())
      const m = first ? /^(.+?):(\d+):/.exec(first) : null
      if (m) return { path: m[1], line: Number(m[2]) }
    }
    return null
  },

  /**
   * Read an EXTERNAL file (absolute path, outside the workspace) for the native
   * attach dialog — images become base64 attachments, everything else text.
   */
  async readExternalAttachment(absPath: string, remote?: Remote): Promise<{
    label: string
    text?: string
    image?: { base64: string; mediaType: string }
  }> {
    if (remote) throw new Error('Not available on SSH sessions yet.')
    const name = absPath.split(sep).pop() ?? absPath
    const mime = mimeForPath(absPath)
    const buf = await readFile(absPath)
    if (mime && mime.startsWith('image/')) {
      return { label: name, image: { base64: buf.toString('base64'), mediaType: mime } }
    }
    return { label: name, text: `${absPath}\n${buf.toString('utf8').slice(0, 8000)}` }
  },

  /** Read a (binary) file as a data: URL for in-app rendering (images/PDF). */
  async readFileDataUrl(root: string, relPath: string, remote?: Remote): Promise<string | null> {
    const mime = mimeForPath(relPath)
    if (!mime) return null
    if (remote) {
      const rel = safeRel(relPath)
      const out = await remote.exec
        .run('sh', ['-c', `base64 < ${shellQuote(rel)}`], { cwd: root })
        .catch(() => null)
      if (!out) return null // file absent / unreadable
      const b64 = out.stdout.replace(/\s+/g, '')
      if (!b64 || Math.floor((b64.length * 3) / 4) > 12 * 1024 * 1024) return null
      return `data:${mime};base64,${b64}`
    }
    const file = safeJoin(root, relPath)
    const s = await stat(file).catch(() => null)
    if (!s || s.size > 12 * 1024 * 1024) return null
    const buf = await readFile(file)
    return `data:${mime};base64,${buf.toString('base64')}`
  },

  /** Create an empty file (fails if it exists). */
  async createFile(root: string, relPath: string, remote?: Remote): Promise<void> {
    if (remote) {
      const rel = safeRel(relPath)
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      const mk = dir ? `mkdir -p ${shellQuote(dir)} && ` : ''
      // fail (like the local flag:'wx') if the target already exists
      const cmd = `if [ -e ${shellQuote(rel)} ]; then echo 'File already exists' >&2; exit 1; fi; ${mk}: > ${shellQuote(rel)}`
      await remote.exec.run('sh', ['-c', cmd], { cwd: root })
      return
    }
    const file = safeJoin(root, relPath)
    if (existsSync(file)) throw new Error('File already exists')
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '', { flag: 'wx' })
  },

  async createDir(root: string, relPath: string, remote?: Remote): Promise<void> {
    if (remote) {
      await remote.exec.run('mkdir', ['-p', safeRel(relPath)], { cwd: root })
      return
    }
    const dir = safeJoin(root, relPath)
    await mkdir(dir, { recursive: true })
  },

  async rename(root: string, fromRel: string, toRel: string, remote?: Remote): Promise<void> {
    if (remote) {
      await remote.exec.run('mv', ['--', safeRel(fromRel), safeRel(toRel)], { cwd: root })
      return
    }
    await rename(safeJoin(root, fromRel), safeJoin(root, toRel))
  },

  async remove(root: string, relPath: string, remote?: Remote): Promise<void> {
    if (remote) {
      await remote.exec.run('rm', ['-rf', '--', safeRel(relPath)], { cwd: root })
      return
    }
    await rm(safeJoin(root, relPath), { recursive: true, force: true })
  },

  /**
   * Resolve a relative import specifier from one file to an actual file in the
   * workspace (for cmd-click go-to-file). Returns the target's relPath, or null
   * for bare/unresolvable specifiers. Tries common extensions and /index.
   */
  async resolveImport(
    root: string,
    fromRel: string,
    spec: string,
    remote?: Remote
  ): Promise<string | null> {
    if (remote) return null // cmd-click resolution not yet available on SSH sessions
    if (!spec.startsWith('.') && !spec.startsWith('/')) return null // bare import — skip
    const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : ''
    const baseRel = spec.startsWith('/') ? spec.slice(1) : normalize(join(fromDir, spec))
    const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.svelte', '.vue']
    const candidates = [
      ...exts.map((e) => baseRel + e),
      ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map((i) => join(baseRel, i))
    ]
    for (const rel of candidates) {
      try {
        const abs = safeJoin(root, rel)
        if (existsSync(abs) && (await stat(abs)).isFile()) {
          return relative(root, abs).split(sep).join('/')
        }
      } catch {
        /* escapes root — skip */
      }
    }
    return null
  },

  /** Flat list of all tracked + untracked (non-ignored) files, for ⌘P. */
  /**
   * All JS/TS source files (path + content) for loading a Monaco TS project so
   * go-to-definition / hover resolve cross-file. Capped + size-limited to keep
   * the renderer responsive on large repos.
   */
  async readSources(root: string, remote?: Remote): Promise<{ path: string; content: string }[]> {
    if (remote) return [] // Monaco TS project loading not yet available on SSH sessions
    const all = await this.listAllFiles(root)
    const src = all
      .filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p))
      .filter((p) => !p.includes('node_modules/'))
      // cap the eager project load: each file becomes a Monaco model synced to
      // the single TS worker. 1500 real monorepo files crushed it (Angel); cross-
      // file navigation to files past the cap falls back to git-grep, which scales
      .slice(0, 500)
    const out: { path: string; content: string }[] = []
    for (const rel of src) {
      try {
        const abs = safeJoin(root, rel)
        if ((await stat(abs)).size > 512 * 1024) continue // skip huge/generated files
        out.push({ path: rel, content: await readFile(abs, 'utf8') })
      } catch {
        /* ignore unreadable */
      }
    }
    return out
  },

  async listAllFiles(root: string, remote?: Remote): Promise<string[]> {
    if (remote) return listAllFilesRemote(root, remote)
    if (!existsSync(root)) return []
    try {
      const { stdout } = await exec(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard'],
        { cwd: root, maxBuffer: 32 * 1024 * 1024 }
      )
      const files = stdout.split('\n').filter(Boolean)
      if (files.length > 0) return files.slice(0, 20000)
    } catch {
      /* not a git repo — fall back to a bounded walk */
    }
    return walk(root, '', 0, [])
  }
}

/**
 * Remote one-level listing. Portable across BSD/GNU: `ls -1Ap` lists one entry
 * per line, includes dotfiles (-A, minus . and ..), and appends a trailing '/'
 * to directories only (-p). No GNU-only `find -printf`.
 */
async function listDirRemote(root: string, relPath: string, remote: Remote): Promise<DirEntry[]> {
  const rel = relPath ? safeRel(relPath) : ''
  const target = rel || '.'
  const out = await remote.exec
    .run('sh', ['-c', `ls -1Ap ${shellQuote(target)}`], { cwd: root })
    .catch(() => ({ stdout: '' })) // dir gone → empty, matching the local ENOENT path
  const entries: DirEntry[] = []
  for (const raw of out.stdout.split('\n')) {
    if (!raw) continue
    const isDir = raw.endsWith('/')
    const name = isDir ? raw.slice(0, -1) : raw
    if (!name || HIDE_BROWSE.has(name)) continue
    const childRel = rel ? `${rel}/${name}` : name
    entries.push({ name, path: childRel, isDir })
  }
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * Remote flat file list for ⌘P — prunes the same dirs the local SKIP set does.
 * `find` prints paths as `./a/b`; we strip the leading `./`. Capped at 20k.
 */
async function listAllFilesRemote(root: string, remote: Remote): Promise<string[]> {
  const cmd =
    `find . \\( -name .git -o -name node_modules -o -name .hang4r-worktrees -o -name .worktrees \\) ` +
    `-prune -o -type f ! -name .DS_Store -print`
  const out = await remote.exec.run('sh', ['-c', cmd], { cwd: root }).catch(() => ({ stdout: '' }))
  return out.stdout
    .split('\n')
    .filter(Boolean)
    .map((p) => (p.startsWith('./') ? p.slice(2) : p))
    .slice(0, 20000)
}

async function walk(root: string, rel: string, depth: number, acc: string[]): Promise<string[]> {
  if (depth > 12 || acc.length > 20000) return acc
  let entries: Dirent[]
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) await walk(root, childRel, depth + 1, acc)
    else acc.push(childRel)
  }
  return acc
}

/** Join root+relPath, guaranteeing the result stays inside root. */
function safeJoin(root: string, relPath: string): string {
  const target = normalize(join(root, relPath))
  const rel = relative(root, target)
  if (rel.startsWith('..' + sep) || rel === '..') {
    throw new Error('path escapes project root')
  }
  return target
}

function mimeForPath(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    pdf: 'application/pdf'
  }
  return map[ext] ?? null
}
