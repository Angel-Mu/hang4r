import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { ChangedFile, DiffScope, MediaSide, ScopedFiles, ScopeSummary } from '../../shared/protocol'
import { LocalExec, shellQuote, type Exec } from './remoteService'

const exec = promisify(execFile)

/** Default root inside a repo where hang4r keeps its per-session worktrees. */
export const DEFAULT_WORKTREE_DIR = '.hang4r-worktrees'

/** Cap on a single media preview payload before we fall back to "too large". */
const MEDIA_PREVIEW_CAP = 20 * 1024 * 1024

async function git(cwd: string, args: string[], via: Exec = LocalExec): Promise<string> {
  // via.run handles the transport: LocalExec = local subprocess (cwd honored),
  // sshExec = the same argv run in a login shell cd'd into cwd on the remote.
  const { stdout } = await via.run('git', args, { cwd })
  return stdout
}

/** Git operations, all shelling out to the system `git`. */
export const GitService = {
  async isRepo(dir: string, via: Exec = LocalExec): Promise<boolean> {
    try {
      const out = await git(dir, ['rev-parse', '--is-inside-work-tree'], via)
      return out.trim() === 'true'
    } catch {
      return false
    }
  },

  async currentBranch(dir: string, via: Exec = LocalExec): Promise<string> {
    const out = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], via)
    return out.trim()
  },

  /**
   * Create an isolated worktree + branch for a session. The worktree folder and
   * branch share the caller's name verbatim (branch optionally namespaced by
   * `branchPrefix` — a user setting, empty by default: the user's name IS the
   * name, nothing prepended). On a collision with an existing folder or branch,
   * `-2`, `-3`, … is appended rather than failing or clobbering.
   * Returns the worktree path and the base branch it forked from.
   */
  async createWorktree(
    repoDir: string,
    name: string,
    worktreeDir: string = DEFAULT_WORKTREE_DIR,
    branchPrefix = ''
  ): Promise<{ worktreePath: string; baseBranch: string }> {
    const baseBranch = await this.currentBranch(repoDir)
    const container = join(repoDir, worktreeDir)
    if (!existsSync(container)) mkdirSync(container, { recursive: true })
    const taken = async (candidate: string): Promise<boolean> => {
      if (existsSync(join(container, candidate))) return true
      try {
        await git(repoDir, ['show-ref', '--verify', `refs/heads/${branchPrefix}${candidate}`])
        return true // branch exists (possibly from a removed worktree)
      } catch {
        return false
      }
    }
    let unique = name
    for (let n = 2; await taken(unique); n++) unique = `${name}-${n}`
    const worktreePath = join(container, unique)
    const branch = `${branchPrefix}${unique}`
    await git(repoDir, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])
    return { worktreePath, baseBranch }
  },

  async removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
    try {
      await git(repoDir, ['worktree', 'remove', '--force', worktreePath])
    } catch {
      // worktree may already be gone; ignore
    }
  },

  /**
   * Re-attach the SAME branch at the SAME path — used to Recreate a worktree that
   * was Dropped (removeWorktree leaves the branch behind). This restores the
   * session's commits, unlike a fresh createWorktree which would branch from HEAD
   * (and dodge the leftover branch by suffixing -2). Returns false if the branch
   * is truly gone, so the caller can fall back to a fresh worktree.
   */
  async reattachWorktree(repoDir: string, worktreePath: string, branch: string): Promise<boolean> {
    try {
      await git(repoDir, ['show-ref', '--verify', `refs/heads/${branch}`])
    } catch {
      return false // branch is gone too → caller makes a fresh one
    }
    if (existsSync(worktreePath)) return true // already attached
    const container = dirname(worktreePath)
    if (!existsSync(container)) mkdirSync(container, { recursive: true })
    await git(repoDir, ['worktree', 'add', worktreePath, branch])
    return true
  },

  /**
   * Commit everything in the worktree as a per-turn checkpoint.
   * Returns the commit sha, or null if there was nothing to commit.
   */
  async commitAll(worktreePath: string, message: string, via: Exec = LocalExec): Promise<string | null> {
    await git(worktreePath, ['add', '-A'], via)
    const status = await git(worktreePath, ['status', '--porcelain'], via)
    if (!status.trim()) return null
    await git(worktreePath, [
      '-c',
      'user.name=hang4r',
      '-c',
      'user.email=hang4r@localhost',
      'commit',
      '-m',
      message,
      '--no-verify'
    ], via)
    return (await git(worktreePath, ['rev-parse', 'HEAD'], via)).trim()
  },

  /**
   * Files changed relative to a base ref (branch tip for worktrees, or HEAD for
   * local sessions). Includes committed + uncommitted changes.
   */
  async changedFiles(cwd: string, baseRef: string, via: Exec = LocalExec): Promise<ChangedFile[]> {
    // committed changes vs base + staged/unstaged, deduped by path
    const numstat = await git(cwd, ['diff', '--numstat', baseRef], via)
    const nameStatus = await git(cwd, ['diff', '--name-status', baseRef], via)
    const files = parseDiffFiles(numstat, nameStatus)
    // untracked files aren't in `git diff` — surface them too
    await appendUntracked(files, cwd, via)
    return files.sort((a, b) => a.path.localeCompare(b.path))
  },

  /**
   * Changed files + aggregate add/del totals for one review scope (the Cursor
   * scope dropdown). `baseRef` is the session's base (branch tip for worktrees,
   * HEAD for local); it only matters for the `uncommitted`/`branch` scopes.
   */
  async scopedFiles(
    cwd: string,
    scope: DiffScope,
    baseRef: string,
    via: Exec = LocalExec
  ): Promise<ScopedFiles> {
    const diffArgs = scopeDiffArgs(scope, baseRef)
    const numstat = await git(cwd, ['diff', '--numstat', ...diffArgs], via).catch(() => '')
    const nameStatus = await git(cwd, ['diff', '--name-status', ...diffArgs], via).catch(() => '')
    const files = parseDiffFiles(numstat, nameStatus)
    if (scopeIncludesUntracked(scope)) await appendUntracked(files, cwd, via)
    files.sort((a, b) => a.path.localeCompare(b.path))
    let adds = 0
    let dels = 0
    for (const f of files) {
      adds += f.additions
      dels += f.deletions
    }
    return { files, adds, dels }
  },

  /** Unified-diff patch for one file within a review scope. */
  async scopedDiff(
    cwd: string,
    scope: DiffScope,
    baseRef: string,
    path: string,
    ignoreWs = false,
    via: Exec = LocalExec
  ): Promise<string> {
    const args = ['diff', ...scopeDiffArgs(scope, baseRef)]
    if (ignoreWs) args.push('-w')
    args.push('--', path)
    let out = await git(cwd, args, via)
    // untracked file in a working-tree scope: show its contents as an added file
    if (scopeIncludesUntracked(scope) && !out.trim()) {
      const tracked = await git(cwd, ['ls-files', '--', path], via).catch(() => '')
      if (!tracked.trim()) {
        out = await git(cwd, ['diff', '--no-index', '/dev/null', path], via).catch((e) => e.stdout ?? '')
      }
    }
    return out
  },

  /**
   * Per-scope file counts + availability for the scope dropdown. `lastTurn`
   * needs a prior checkpoint (HEAD~1); `branch` needs a distinct base ref
   * (worktree sessions) — both are hidden otherwise.
   */
  async scopeSummary(cwd: string, baseRef: string, via: Exec = LocalExec): Promise<ScopeSummary[]> {
    const hasRef = async (ref: string): Promise<boolean> => {
      try {
        await git(cwd, ['rev-parse', '--verify', '--quiet', ref], via)
        return true
      } catch {
        return false
      }
    }
    const lastTurnOk = await hasRef('HEAD~1')
    const branchOk = !!baseRef && baseRef !== 'HEAD' && (await hasRef(baseRef))
    const scopes: DiffScope[] = ['lastTurn', 'uncommitted', 'unstaged', 'staged', 'branch']
    const out: ScopeSummary[] = []
    for (const scope of scopes) {
      const available =
        scope === 'lastTurn' ? lastTurnOk : scope === 'branch' ? branchOk : true
      let count = 0
      if (available) count = (await this.scopedFiles(cwd, scope, baseRef, via)).files.length
      out.push({ scope, count, available })
    }
    return out
  },

  /** Commit everything with a user-supplied message (review flow "Commit"). */
  async commitWithMessage(cwd: string, message: string, via: Exec = LocalExec): Promise<string | null> {
    return this.commitAll(cwd, message, via)
  },

  /**
   * Squash-merge a session branch back into the base branch (Cursor's
   * "apply/merge" review action; Crystal's rebase-to-main pattern).
   */
  async mergeToBase(repoDir: string, branch: string, message: string): Promise<void> {
    const status = await git(repoDir, ['status', '--porcelain'])
    if (status.trim()) {
      throw new Error('Base worktree has uncommitted changes — commit or stash them first.')
    }
    await git(repoDir, ['merge', '--squash', branch])
    await git(repoDir, [
      '-c',
      'user.name=hang4r',
      '-c',
      'user.email=hang4r@localhost',
      'commit',
      '-m',
      message,
      '--no-verify'
    ])
  },

  /**
   * Push the session branch and open a PR via the gh CLI. Returns the PR URL.
   * `via` runs both push and `gh` local or over ssh (same Exec seam as the
   * rest of the review actions); `hostLabel` is only used to word the
   * gh-missing error for a remote host.
   */
  async createPr(
    cwd: string,
    branch: string,
    title: string,
    body: string,
    via: Exec = LocalExec,
    hostLabel?: string
  ): Promise<string> {
    await this.push(cwd, branch, via)
    // If a PR already exists for this branch, OPEN it instead of failing to
    // create a duplicate. gh pr create errors in that case with the existing
    // URL in its message (Angel hit "PR failed: …/pull/2283" — that WAS the
    // PR). Check up-front, and also salvage a URL from a create error.
    try {
      const { stdout } = await via.run(
        'gh',
        ['pr', 'view', branch, '--json', 'url', '--jq', '.url'],
        { cwd, timeout: 30_000 }
      )
      const existing = stdout.trim()
      if (/^https?:\/\//.test(existing)) return existing
    } catch {
      /* no existing PR (or gh view unsupported) — fall through to create */
    }
    let stdout: string
    try {
      ;({ stdout } = await via.run(
        'gh',
        ['pr', 'create', '--head', branch, '--title', title, '--body', body],
        { cwd, timeout: 60_000 }
      ))
    } catch (err) {
      const existing = extractPrUrl(err)
      if (existing) return existing
      throw ghError(err, hostLabel)
    }
    const url = stdout.trim().split('\n').pop() ?? ''
    return url
  },

  /**
   * Working-tree status map for the explorer badges: relPath -> {badge, staged}.
   * Uses porcelain -z; badge is the most significant single letter (VS Code style).
   */
  async statusMap(cwd: string, via: Exec = LocalExec): Promise<Record<string, { badge: string; staged: boolean }>> {
    const out = await git(cwd, ['status', '--porcelain', '-z', '-uall'], via).catch(() => '')
    const map: Record<string, { badge: string; staged: boolean }> = {}
    const parts = out.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]
      if (!entry || entry.length < 3) continue
      const x = entry[0]
      const y = entry[1]
      let path = entry.slice(3)
      if (x === 'R' || y === 'R') {
        // rename: next \0-part is the original path; the new path is this one
        i++
      }
      const staged = x !== ' ' && x !== '?'
      let badge = 'M'
      if (x === '?' && y === '?') badge = 'U' // untracked
      else if (x === 'A' || y === 'A') badge = 'A'
      else if (x === 'D' || y === 'D') badge = 'D'
      else if (x === 'R' || y === 'R') badge = 'R'
      else if (x === 'U' || y === 'U') badge = 'C' // conflict
      else badge = 'M'
      map[path] = { badge, staged }
    }
    return map
  },

  async push(cwd: string, branch: string, via: Exec = LocalExec): Promise<void> {
    await git(cwd, ['push', '-u', 'origin', branch], via)
  },
  async createBranch(cwd: string, branch: string, via: Exec = LocalExec): Promise<void> {
    await git(cwd, ['checkout', '-b', branch], via)
  },

  /**
   * Per-line dirty-diff status for the editor gutter (working tree vs HEAD).
   * Returns 1-based NEW-file line numbers. VS Code semantics: pure inserts are
   * `added`, replacements are `modified`, pure removals mark a `deleted` line.
   */
  async lineStatus(
    cwd: string,
    path: string,
    via: Exec = LocalExec
  ): Promise<{ added: number[]; modified: number[]; deleted: number[] }> {
    const added: number[] = []
    const modified: number[] = []
    const deleted: number[] = []
    // untracked → whole file is new
    const tracked = await git(cwd, ['ls-files', '--', path], via).catch(() => '')
    if (!tracked.trim()) {
      try {
        // read the working file to count its lines — locally via fs, remotely via `cat`
        const content =
          via === LocalExec
            ? await readFile(join(cwd, path), 'utf8')
            : (await via.run('cat', [path], { cwd })).stdout
        const n = content.split('\n').length
        for (let i = 1; i <= n; i++) added.push(i)
      } catch {
        /* ignore */
      }
      return { added, modified, deleted }
    }
    const out = await git(cwd, ['diff', 'HEAD', '--unified=0', '--', path], via).catch(() => '')
    for (const line of out.split('\n')) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!m) continue
      const rem = m[1] === undefined ? 1 : Number(m[1])
      const start = Number(m[2])
      const add = m[3] === undefined ? 1 : Number(m[3])
      if (add === 0) {
        deleted.push(Math.max(1, start))
      } else if (rem === 0) {
        for (let i = 0; i < add; i++) added.push(start + i)
      } else {
        for (let i = 0; i < add; i++) modified.push(start + i)
        if (rem > add) deleted.push(start + add - 1)
      }
    }
    return { added, modified, deleted }
  },

  /**
   * The single-hunk unified-diff patch (file header + the one hunk) covering a
   * given NEW-file line, for inline editor-gutter stage/revert. Returns null for
   * untracked files or lines with no change (caller falls back to whole-file).
   */
  async hunkPatchAtLine(cwd: string, path: string, line: number, via: Exec = LocalExec): Promise<string | null> {
    const tracked = await git(cwd, ['ls-files', '--', path], via).catch(() => '')
    if (!tracked.trim()) return null
    const diff = await git(cwd, ['diff', 'HEAD', '--', path], via).catch(() => '')
    if (!diff.trim()) return null
    const lines = diff.split('\n')
    let i = 0
    const header: string[] = []
    while (i < lines.length && !lines[i].startsWith('@@')) header.push(lines[i++])
    while (i < lines.length) {
      const hStart = i
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(lines[i])
      i++
      while (i < lines.length && !lines[i].startsWith('@@')) i++
      if (!m) continue
      const start = Number(m[1])
      const count = m[2] === undefined ? 1 : Number(m[2])
      const end = start + Math.max(count, 1) - 1
      // count 0 = pure deletion: the change sits "between" lines around `start`
      if (line >= (count === 0 ? start - 1 : start) && line <= (count === 0 ? start + 1 : end)) {
        return [...header, ...lines.slice(hStart, i)].join('\n')
      }
    }
    return null
  },

  async stage(cwd: string, path: string, via: Exec = LocalExec): Promise<void> {
    await git(cwd, ['add', '--', path], via)
  },
  async unstage(cwd: string, path: string, via: Exec = LocalExec): Promise<void> {
    await git(cwd, ['reset', '-q', 'HEAD', '--', path], via).catch(() => {})
  },
  async discard(cwd: string, path: string, via: Exec = LocalExec): Promise<void> {
    // tracked → checkout; untracked → remove the file
    const tracked = await git(cwd, ['ls-files', '--', path], via).catch(() => '')
    if (tracked.trim()) {
      await git(cwd, ['checkout', '--', path], via)
    } else {
      await git(cwd, ['clean', '-fd', '--', path], via).catch(() => {})
    }
  },

  /**
   * Apply a unified-diff patch to the working tree or index (per-hunk stage/
   * revert). Writes the patch to a temp file and pipes it through `git apply`.
   */
  async applyPatch(
    cwd: string,
    patch: string,
    opts: { reverse?: boolean; cached?: boolean },
    via: Exec = LocalExec
  ): Promise<void> {
    // NOTE: no --unidiff-zero — that disables context checking and misapplies
    // when earlier hunks in the file shifted line numbers. --recount lets git
    // recompute hunk counts (robust to our per-hunk slicing) while keeping the
    // context safety net. Falls back to a 3-way merge apply if the plain apply
    // can't locate the hunk (e.g. the working tree drifted).
    const base = ['apply', '--recount']
    if (opts.reverse) base.push('--reverse')
    if (opts.cached) base.push('--cached')
    // Normalize to EXACTLY one trailing newline. A reconstructed single-hunk
    // patch that ends in "\ No newline at end of file" followed by a blank line
    // is invalid and git rejects it ("patch does not apply").
    const body = patch.replace(/\n+$/, '') + '\n'
    if (via !== LocalExec) {
      // remote: no stdin through the Exec seam — ship the patch base64'd and
      // decode it into git apply on the remote (same trick as file writes)
      const b64 = Buffer.from(body, 'utf8').toString('base64')
      const run = (extra: string[]): Promise<unknown> =>
        via.run(
          'sh',
          ['-c', `echo ${shellQuote(b64)} | base64 -d | git ${[...base, ...extra, '-'].join(' ')}`],
          { cwd }
        )
      try {
        await run([])
      } catch {
        await run(['--3way'])
      }
      return
    }
    const run = (extra: string[]): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const child = execFile(
          'git',
          [...base, ...extra, '-'],
          { cwd, maxBuffer: 16 * 1024 * 1024 },
          (err) => (err ? reject(err) : resolve())
        )
        child.stdin?.end(body)
      })
    try {
      await run([])
    } catch {
      await run(['--3way'])
    }
  },

  /** Unified diff text for one file (or the whole tree if path omitted). */
  async fileDiff(cwd: string, baseRef: string, path?: string, ignoreWs = false, via: Exec = LocalExec): Promise<string> {
    const args = ['diff', baseRef]
    if (ignoreWs) args.push('-w')
    if (path) args.push('--', path)
    let out = await git(cwd, args, via)
    // include untracked file contents as an added-file diff
    if (path) {
      const tracked = await git(cwd, ['ls-files', '--', path], via)
      if (!tracked.trim() && !out.trim()) {
        try {
          out = await git(cwd, ['diff', '--no-index', '/dev/null', path], via).catch((e) => e.stdout ?? '')
        } catch {
          /* ignore */
        }
      }
    }
    return out
  },

  /**
   * Content of a media file at a git ref (the "before" side of a binary diff),
   * as a data: URL. Returns null when the blob is absent at that ref (e.g. an
   * added file has no base version) or the extension isn't a known media type;
   * a `tooLarge` side when the blob exceeds the preview cap.
   */
  async fileDataUrlAtRef(
    cwd: string,
    ref: string,
    path: string,
    via: Exec = LocalExec,
    maxBytes = MEDIA_PREVIEW_CAP
  ): Promise<MediaSide | null> {
    const mime = mediaMime(path)
    if (!mime) return null
    let size: number
    try {
      size = Number((await git(cwd, ['cat-file', '-s', `${ref}:${path}`], via)).trim())
    } catch {
      return null // blob doesn't exist at this ref
    }
    if (!Number.isFinite(size)) return null
    if (size > maxBytes) return { dataUrl: '', size, tooLarge: true }
    let base64: string
    if (via === LocalExec) {
      const { stdout } = await exec('git', ['show', `${ref}:${path}`], {
        cwd,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024
      })
      base64 = (stdout as unknown as Buffer).toString('base64')
    } else {
      // no local Buffer read over ssh — fetch the blob already base64-encoded
      const cmd = `git show ${shellQuote(`${ref}:${path}`)} | base64`
      const { stdout } = await via.run('sh', ['-c', cmd], { cwd })
      base64 = stdout.replace(/\s+/g, '')
    }
    return { dataUrl: `data:${mime};base64,${base64}`, size, tooLarge: false }
  },

  /**
   * Content of a media file in the working tree (the "after" side of a binary
   * diff), as a data: URL. Returns null when the file is absent (e.g. it was
   * deleted) or isn't a known media type.
   */
  async workingFileDataUrl(
    cwd: string,
    path: string,
    via: Exec = LocalExec,
    maxBytes = MEDIA_PREVIEW_CAP
  ): Promise<MediaSide | null> {
    const mime = mediaMime(path)
    if (!mime) return null
    if (via === LocalExec) {
      const abs = join(cwd, path)
      const s = await stat(abs).catch(() => null)
      if (!s || !s.isFile()) return null
      if (s.size > maxBytes) return { dataUrl: '', size: s.size, tooLarge: true }
      const buf = await readFile(abs)
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: s.size, tooLarge: false }
    }
    // remote: size cap first (avoid pulling a huge file), then base64 the bytes
    const sizeOut = await via
      .run('sh', ['-c', `wc -c < ${shellQuote(path)}`], { cwd })
      .catch(() => null)
    if (!sizeOut) return null // file absent or unreadable
    const size = Number(sizeOut.stdout.trim())
    if (!Number.isFinite(size)) return null
    if (size > maxBytes) return { dataUrl: '', size, tooLarge: true }
    const { stdout } = await via.run('sh', ['-c', `base64 < ${shellQuote(path)}`], { cwd })
    const base64 = stdout.replace(/\s+/g, '')
    return { dataUrl: `data:${mime};base64,${base64}`, size, tooLarge: false }
  }
}

/**
 * Turn a failed `gh` invocation into a clean, actionable error instead of a
 * raw exec dump. Distinguishes "gh isn't installed" (ENOENT locally; a shell
 * "command not found" line over ssh) from gh's own failures (not a github
 * repo, no auth, etc.), where we surface gh's own last stderr line verbatim.
 */
/** Pull a github PR URL out of a gh error (it reports the existing PR's URL when
 *  `pr create` refuses a duplicate: "a pull request … already exists: <url>"). */
function extractPrUrl(err: unknown): string | null {
  const e = err as { stderr?: string; stdout?: string; message?: string }
  const text = `${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`
  const m = text.match(/https?:\/\/\S*\/pull\/\d+/)
  return m ? m[0] : null
}

function ghError(err: unknown, hostLabel?: string): Error {
  const e = err as { code?: string; stderr?: string; message?: string }
  const stderr = (e.stderr ?? '').trim()
  const notFound = e.code === 'ENOENT' || /\bgh\b[^\n]{0,40}not found|not found[^\n]{0,40}\bgh\b/i.test(stderr)
  if (notFound) {
    return new Error(
      hostLabel
        ? `gh CLI not found on ${hostLabel} — install GitHub CLI on the remote host.`
        : 'gh CLI not found — install GitHub CLI (https://cli.github.com).'
    )
  }
  const line = stderr.split('\n').filter(Boolean).pop() ?? e.message ?? 'gh pr create failed'
  return new Error(line)
}

/** MIME type for a media file we can preview inline (images + PDF), else null. */
function mediaMime(path: string): string | null {
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

/** The `git diff` ref args for a review scope (numstat/name-status/patch share). */
function scopeDiffArgs(scope: DiffScope, baseRef: string): string[] {
  switch (scope) {
    case 'lastTurn':
      return ['HEAD~1']
    case 'uncommitted':
      // baseRef vs working tree: HEAD for local sessions, the base branch for
      // worktrees (where per-turn checkpoints mean HEAD alone would be empty).
      // For worktrees this is really "all changes vs base" — the DiffView labels
      // it accordingly (NOT "Uncommitted", which confused Angel: git status was
      // clean yet this showed 43 checkpointed files). Hunk revert/stage act on
      // the working tree, so this scope must stay base-relative to be reviewable.
      return [baseRef]
    case 'unstaged':
      return []
    case 'staged':
      return ['--cached']
    case 'branch':
      return [`${baseRef}...HEAD`]
  }
}

/** Scopes that compare the working tree, so untracked files belong in them. */
function scopeIncludesUntracked(scope: DiffScope): boolean {
  return scope === 'lastTurn' || scope === 'uncommitted' || scope === 'unstaged'
}

/** Parse `git diff --numstat` + `--name-status` into ChangedFile rows. */
function parseDiffFiles(numstat: string, nameStatus: string): ChangedFile[] {
  const statusByPath = new Map<string, string>()
  for (const line of nameStatus.trim().split('\n')) {
    if (!line) continue
    const [code, ...rest] = line.split('\t')
    statusByPath.set(rest[rest.length - 1], code[0])
  }
  const files: ChangedFile[] = []
  for (const line of numstat.trim().split('\n')) {
    if (!line) continue
    const [add, del, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t')
    files.push({
      path,
      status: mapStatus(statusByPath.get(path) ?? 'M'),
      additions: add === '-' ? 0 : Number(add),
      deletions: del === '-' ? 0 : Number(del)
    })
  }
  return files
}

/** Append not-yet-tracked files (absent from `git diff`) as added entries. */
async function appendUntracked(files: ChangedFile[], cwd: string, via: Exec): Promise<void> {
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard'], via).catch(() => '')
  for (const path of untracked.trim().split('\n')) {
    if (!path) continue
    files.push({ path, status: 'added', additions: 0, deletions: 0 })
  }
}

function mapStatus(code: string): ChangedFile['status'] {
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return 'modified'
  }
}
