import { readdir, readFile, stat, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { Attachment, DirEntry } from '../../shared/protocol'
import { shellQuote, type Exec } from './remoteService'

const exec = promisify(execFile)

/**
 * Absolute paths of every git worktree of the repo containing `dir` (this
 * worktree, its siblings, and the main checkout), via `git worktree list`.
 * Returns [] when `dir` isn't a git repo or git fails. Used to resolve a file
 * referenced by a RELATIVE path from the conversation that actually lives in a
 * SIBLING worktree (a session runs in one worktree, but agents often reference
 * files they wrote in another — Angel).
 */
async function gitWorktrees(dir: string): Promise<string[]> {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    maxBuffer: 1024 * 1024
  }).catch(() => ({ stdout: '' }))
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) out.push(line.slice('worktree '.length).trim())
  }
  return out
}

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

/**
 * Resolve a path for a LOCAL read/write. A user can open a file OUTSIDE the
 * worktree (drop it, click an absolute/~ path an agent wrote) as a real editable
 * tab — so an absolute or `~` path is used VERBATIM (no worktree sandbox; ~ is
 * expanded). A RELATIVE path still goes through safeJoin, so agent-supplied `..`
 * traversal stays blocked. (Remote/ssh sessions keep safeRel — absolute paths
 * there are the remote host's and out-of-tree editing degrades to a notice.)
 */
function localPath(root: string, p: string): string {
  const home = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
  return isAbsolute(home) ? home : safeJoin(root, p)
}

/** Directories the flat ⌘P list / search never DESCEND into — huge or noisy. */
const SKIP = new Set(['.git', 'node_modules', '.hang4r-worktrees', '.worktrees', '.DS_Store'])
/** heavy build/dep dirs kept OUT of the ⌘P finder even when it includes ignored
 *  files, so the quick-open list stays useful (source + docs) not flooded */
/**
 * Directories ⌘P and @-mentions never look inside. The line is dependency and
 * framework CACHES — enormous, and nobody authored them — not build output.
 *
 * `out`, `dist`, `build` and `coverage` used to be here and cost Angel a real
 * file: his generated artwork lands in `out/`, so `@gen-2026…` matched nothing
 * while the tree showed the images right there. Those names describe a project's
 * PRODUCT as often as its throwaways, they hold tens of files rather than tens
 * of thousands, and a file you can see in the tree must be reachable by name.
 */
const FINDER_SKIP_DIRS = [
  '.git',
  'node_modules',
  '.next',
  '.nx',
  '.turbo',
  '.venv',
  '.cache',
  '.hang4r-worktrees',
  '.worktrees'
]
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
  /** absolute on-disk path for a workspace-relative path (throws if it escapes root) */
  absPath(root: string, relPath: string): string {
    return safeJoin(root, relPath)
  },
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
    const file = localPath(root, relPath)
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
    const file = localPath(root, relPath)
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
    // A symbol is often DECLARED again in a test (const foo = …, function foo())
    // and git grep would return that test file first, so go-to-definition jumped
    // into specs instead of the real source (Angel). Prefer any non-test match
    // over any test match — falling back to a test file only if it's the only hit.
    const isTestPath = (p: string): boolean =>
      /(\.(test|spec|stories|cy|e2e)\.[cm]?[jt]sx?$)|((^|\/)(__tests__|__mocks__|e2e|tests?|spec|cypress)\/)/i.test(
        p
      )
    let fallback: { path: string; line: number } | null = null
    for (const pat of patterns) {
      const { stdout } = await exec(
        'git',
        ['grep', '--no-color', '-n', '-E', '-I', '--untracked', '-e', pat],
        { cwd: root, maxBuffer: 8 * 1024 * 1024 }
      ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }))
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const m = /^(.+?):(\d+):/.exec(line)
        if (!m) continue
        const hit = { path: m[1], line: Number(m[2]) }
        if (isTestPath(hit.path)) {
          fallback ??= hit // remember the first test hit in case there's nothing else
          continue
        }
        return hit // first non-test declaration, most-definitive pattern first
      }
    }
    return fallback
  },

  /**
   * Read an EXTERNAL file (absolute path, outside the workspace) for the native
   * attach dialog — images become base64 attachments, everything else text.
   */
  async readExternalAttachment(absPath: string, remote?: Remote): Promise<Attachment> {
    if (remote) throw new Error('Not available on SSH sessions yet.')
    const name = absPath.split(sep).pop() ?? absPath
    const mime = mimeForPath(absPath)
    const buf = await readFile(absPath)
    if (mime && mime.startsWith('image/')) {
      return { label: name, image: { base64: buf.toString('base64'), mediaType: mime } }
    }
    // non-image: still hand the agent the text, but tag it as a FILE so the chat
    // renders a card (click → preview) instead of dumping the raw bytes inline.
    return {
      label: name,
      text: `${absPath}\n${buf.toString('utf8').slice(0, 8000)}`,
      file: { name, path: absPath, mediaType: mime ?? undefined, external: true }
    }
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
    const file = localPath(root, relPath)
    const s = await stat(file).catch(() => null)
    if (!s || s.size > 12 * 1024 * 1024) return null
    const buf = await readFile(file)
    return `data:${mime};base64,${buf.toString('base64')}`
  },

  /**
   * Re-read an attached file for click-to-preview. image/pdf → a data: URL;
   * everything else → utf-8 text (so the viewer shows real content, not bytes).
   * `external` reads the absolute path the user explicitly attached; otherwise
   * the path is resolved (and sandboxed) inside the workspace.
   */
  async previewAttachment(
    root: string,
    p: string,
    external?: boolean
  ): Promise<{ dataUrl?: string; text?: string; kind: string } | null> {
    // expand a leading ~ (home) so a path like ~/.claude/… the agent wrote
    // outside the worktree resolves to a real absolute path we can preview.
    const expanded = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
    let file = external && isAbsolute(expanded) ? expanded : safeJoin(root, p)
    let s = await stat(file).catch(() => null)
    // Not at its literal location? A path referenced by bare/short name in the
    // conversation (e.g. "settings.local.json") often lives in a subdir like
    // .claude/. Resolve it by BASENAME within the project — but only when EXACTLY
    // one file matches, so we never guess wrong. includeIgnored so local files
    // (a gitignored .claude/settings.local.json) still resolve.
    if (!s && !isAbsolute(expanded)) {
      const base = basename(expanded)
      const matches = (await this.listAllFiles(root, undefined, true).catch(() => [])).filter(
        (f) => basename(f) === base
      )
      if (matches.length === 1) {
        file = safeJoin(root, matches[0])
        s = await stat(file).catch(() => null)
      }
    }
    // STILL not found and relative? The file may live in a SIBLING worktree of
    // the same repo (this session runs in ONE worktree, but the agent references
    // a file it wrote in another — clicking that path errored and forced Finder,
    // Angel). Try <each worktree>/<relPath>; open the first that exists.
    if (!s && !isAbsolute(expanded)) {
      const rel = expanded.replace(/^(?:\.\/)+/, '')
      for (const wt of await gitWorktrees(root)) {
        const cand = join(wt, rel)
        const cs = await stat(cand).catch(() => null)
        if (cs?.isFile()) {
          file = cand
          s = cs
          break
        }
      }
    }
    if (!s) return null
    const kind = attachmentKind(p)
    if (s.size > 12 * 1024 * 1024) {
      return { kind, text: '(file is too large to preview — over 12 MB)' }
    }
    if (kind === 'image' || kind === 'pdf') {
      const mime = mimeForPath(p)
      if (!mime) return { kind: 'text', text: '(cannot preview this file type)' }
      const buf = await readFile(file)
      return { kind, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    }
    const buf = await readFile(file)
    return { kind, text: buf.toString('utf8').slice(0, 500_000) }
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

  async listAllFiles(root: string, remote?: Remote, includeIgnored = false): Promise<string[]> {
    if (remote) return listAllFilesRemote(root, remote)
    if (!existsSync(root)) return []
    try {
      // includeIgnored (⌘P quick-open): show gitignored files too — a file the
      // agent created this session can sit in a gitignored docs dir yet be right
      // there in the tree, and ⌘P "No files match" was maddening (Angel). We drop
      // --exclude-standard but pass our own --exclude for the heavy build/dep dirs
      // so the finder isn't flooded with node_modules/dist. Callers that feed the
      // TS worker (readSources) keep the default (respect .gitignore).
      const args = ['ls-files', '--cached', '--others']
      if (includeIgnored) for (const d of FINDER_SKIP_DIRS) args.push('--exclude', d)
      else args.push('--exclude-standard')
      const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 })
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

/** classify an attachment path for preview (mirrors the renderer's mediaKind) */
function attachmentKind(path: string): 'image' | 'pdf' | 'markdown' | 'html' | 'text' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (['md', 'mdx', 'markdown'].includes(ext)) return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  return 'text'
}
