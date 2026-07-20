import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, normalize, relative, sep } from 'node:path'
import type { Exec } from './remoteService'
import { FileService } from './fileService'
import type {
  ReplaceRequest,
  SearchFileResult,
  SearchMatch,
  SearchOptions,
  SearchResults
} from '../../shared/protocol'

/** Directories we never descend into when searching a project. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.hang4r-worktrees',
  '.worktrees'
])
/** Cap so a single monster file can't stall the walk. */
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** Hard ceiling on total matches returned (renderer stays responsive). */
const RESULT_CAP = 5000
/** Displayed line snippet length. */
const SNIPPET_MAX = 250

/**
 * Content search-in-files, scoped to a workspace root. Pure Node (no `rg`
 * shell-out, so it works in the packaged app). Recursive walk that skips VCS /
 * build dirs and binary files (NUL-byte sniff), with find + replace.
 */
export const SearchService = {
  async search(
    root: string,
    options: SearchOptions,
    remote?: { exec: Exec }
  ): Promise<SearchResults> {
    const empty: SearchResults = { files: [], resultCount: 0, fileCount: 0, limitHit: false }
    if (!options.query) return empty
    let regex: RegExp
    try {
      regex = buildRegex(options, true)
    } catch {
      // invalid regex — surface as "no results" rather than throwing across IPC
      return empty
    }

    if (remote) return searchRemote(root, options, remote.exec, regex, empty)

    const files: SearchFileResult[] = []
    let resultCount = 0
    let limitHit = false

    const paths = await collectFiles(root)
    for (const abs of paths) {
      if (limitHit) break
      const rel = relative(root, abs).split(sep).join('/')
      const content = await readTextFile(abs)
      if (content === null) continue

      const matches: SearchMatch[] = []
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const lineMatches = matchLine(lines[i], i + 1, regex)
        for (const m of lineMatches) {
          matches.push(m)
          resultCount++
          if (resultCount >= RESULT_CAP) {
            limitHit = true
            break
          }
        }
        if (limitHit) break
      }
      if (matches.length) files.push({ file: rel, matches })
    }

    return { files, resultCount, fileCount: files.length, limitHit }
  },

  /**
   * Rewrite the affected files on disk. Scope selects what gets replaced:
   *  - { kind: 'all' }                     → every match in every file
   *  - { kind: 'file', file }              → every match in one file
   *  - { kind: 'match', file, line, column } → one specific match
   * Regex mode honours $1-style group references in `replacement`.
   */
  async replace(
    root: string,
    req: ReplaceRequest,
    remote?: { exec: Exec }
  ): Promise<{ filesChanged: number; replacements: number }> {
    const { options, scope } = req
    if (!options.query) return { filesChanged: 0, replacements: 0 }
    // Remote (ssh) sessions: the regex/replace semantics stay HERE in Node
    // (identical local/remote — no sed dialect drift); only the file I/O goes
    // over the Exec seam. A truncated remote read is NEVER written back.
    const readF = async (rel: string): Promise<string | null> => {
      if (remote) {
        try {
          const r = await FileService.readFile(root, rel, remote)
          if (r.truncated || r.content.includes('\0')) return null
          return r.content
        } catch {
          return null
        }
      }
      return readTextFile(safeJoin(root, rel))
    }
    const writeF = async (rel: string, content: string): Promise<void> => {
      if (remote) await FileService.writeFile(root, rel, content, remote)
      else await writeFile(safeJoin(root, rel), content, 'utf8')
    }
    // literal mode: the replacement is verbatim — neutralize $-sequences
    // ($&, $$, $`, $') that String.replace would otherwise expand
    const replacement = options.isRegex
      ? req.replacement
      : req.replacement.replace(/\$/g, '$$$$')
    const globalRe = buildRegex(options, true)

    let filesChanged = 0
    let replacements = 0

    const applyToFile = async (rel: string, onlyAt?: { line: number; column: number }): Promise<void> => {
      const content = await readF(rel)
      if (content === null) return

      let next: string
      let count = 0
      if (onlyAt) {
        const lines = content.split('\n')
        const idx = onlyAt.line - 1
        if (idx < 0 || idx >= lines.length) return
        const lineRe = buildRegex(options, true)
        const singleRe = buildRegex(options, false)
        let hit = false
        lines[idx] = lines[idx].replace(lineRe, (matched, ...args) => {
          // args = [...groups, offset, whole] — offset is the 0-based column
          const offset = args[args.length - 2] as number
          if (!hit && offset === onlyAt.column - 1) {
            hit = true
            count++
            return matched.replace(singleRe, replacement)
          }
          return matched
        })
        if (!hit) return
        next = lines.join('\n')
      } else {
        next = content.replace(globalRe, (matched) => {
          count++
          return matched.replace(buildRegex(options, false), replacement)
        })
      }

      if (count > 0 && next !== content) {
        await writeF(rel, next)
        filesChanged++
        replacements += count
      }
    }

    if (scope.kind === 'match') {
      await applyToFile(scope.file, { line: scope.line, column: scope.column })
    } else if (scope.kind === 'file') {
      await applyToFile(scope.file)
    } else {
      // scope 'all' — re-run the search to learn which files are affected
      const results = await this.search(root, options, remote)
      for (const f of results.files) await applyToFile(f.file)
    }

    return { filesChanged, replacements }
  }
}

/**
 * Remote (ssh) search: grep filters candidate lines on the host, then the
 * SAME matchLine/buildRegex compute columns + highlights in Node — one result
 * shape for the renderer regardless of where the search ran. grep's regex
 * dialect only pre-filters; a line grep found but the JS regex doesn't
 * re-match is dropped (rare dialect divergence, safe direction).
 */
async function searchRemote(
  root: string,
  options: SearchOptions,
  exec: Exec,
  regex: RegExp,
  empty: SearchResults
): Promise<SearchResults> {
  const args = ['-r', '-n', '-I'] // recursive, line numbers, skip binaries
  if (!options.matchCase) args.push('-i')
  if (options.wholeWord) args.push('-w')
  args.push(options.isRegex ? '-E' : '-F')
  for (const d of SKIP_DIRS) args.push(`--exclude-dir=${d}`)
  args.push('--', options.query, '.')
  let stdout = ''
  try {
    ;({ stdout } = await exec.run('grep', args, { cwd: root, timeout: 30_000 }))
  } catch {
    return empty // grep exits 1 on zero matches, 2 on bad pattern — both "no results"
  }
  const byFile = new Map<string, SearchMatch[]>()
  let resultCount = 0
  let limitHit = false
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const m = /^\.\/(.+?):(\d+):(.*)$/.exec(line)
    if (!m) continue
    const [, rel, lineNoStr, text] = m
    const lineMatches = matchLine(text, Number(lineNoStr), regex)
    if (!lineMatches.length) continue
    const list = byFile.get(rel) ?? []
    for (const match of lineMatches) {
      list.push(match)
      resultCount++
      if (resultCount >= RESULT_CAP) {
        limitHit = true
        break
      }
    }
    byFile.set(rel, list)
    if (limitHit) break
  }
  const files: SearchFileResult[] = [...byFile.entries()].map(([file, matches]) => ({
    file,
    matches
  }))
  return { files, resultCount, fileCount: files.length, limitHit }
}

/** Build the search RegExp from the user options. Throws on invalid regex. */
function buildRegex(options: SearchOptions, global: boolean): RegExp {
  let pattern = options.isRegex ? options.query : escapeRegex(options.query)
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`
  let flags = global ? 'g' : ''
  if (!options.matchCase) flags += 'i'
  return new RegExp(pattern, flags)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Find every match on one line, producing display-ready snippets. */
function matchLine(raw: string, lineNo: number, regex: RegExp): SearchMatch[] {
  const out: SearchMatch[] = []
  // trim leading whitespace for display (VS Code-style); keep true columns
  const trimStart = raw.length - raw.trimStart().length
  const snippet = raw.slice(trimStart, trimStart + SNIPPET_MAX)
  regex.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(raw)) !== null) {
    const start = m.index
    const len = m[0].length
    out.push({
      line: lineNo,
      column: start + 1,
      text: snippet,
      matchStart: start - trimStart,
      matchLength: len
    })
    // guard against zero-width matches (e.g. a regex that can match empty)
    if (len === 0) regex.lastIndex++
    if (out.length > 200) break // pathological line — cap per-line matches
  }
  return out
}

/** Depth-first collect of searchable files under root (skips VCS/build dirs). */
async function collectFiles(root: string): Promise<string[]> {
  const acc: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.git')) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(abs)
      } else if (e.isFile()) {
        acc.push(abs)
      }
    }
  }
  await walk(root)
  return acc
}

/** Read a file as text, or null if it's binary / too large / unreadable. */
async function readTextFile(abs: string): Promise<string | null> {
  try {
    const s = await stat(abs)
    if (!s.isFile() || s.size > MAX_FILE_BYTES) return null
    const buf = await readFile(abs)
    // binary sniff: a NUL byte in the first 8KB → treat as binary, skip
    const sniff = buf.subarray(0, 8192)
    if (sniff.includes(0)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
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
