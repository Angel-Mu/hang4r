import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import parseDiff from 'parse-diff'
import type {
  ChangedFile,
  DiffScope,
  MediaDiff,
  MediaSide,
  ReviewComment,
  ScopeSummary
} from '../../../shared/protocol'
import { useHang4r } from '../state/store'
import { Icon } from './Icon'
import { mediaKind } from './MediaViewer'

const STATUS_MARK: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

/** Human labels for the scope dropdown (Cursor's "Uncommitted / Staged / …"). */
const SCOPE_LABEL: Record<DiffScope, string> = {
  lastTurn: 'Last Turn',
  uncommitted: 'Uncommitted',
  unstaged: 'Unstaged',
  staged: 'Staged',
  branch: 'Branch Commits'
}

/**
 * On a worktree the "uncommitted" scope actually diffs the working tree against
 * the BASE branch, so it includes the agent's per-turn checkpoint commits — a
 * clean tree can still list dozens of files. Calling that "Uncommitted"
 * contradicts `git status` (Angel's confusion), so label it "All Changes" there.
 * Local sessions have no checkpoints, so "Uncommitted" is literally true.
 */
function scopeLabel(scope: DiffScope, isWorktree: boolean): string {
  if (scope === 'uncommitted' && isWorktree) return 'All Changes'
  return SCOPE_LABEL[scope]
}

/** Working-tree scopes where per-hunk stage/revert makes sense (else read-only). */
function scopeAllowsHunkOps(scope: DiffScope): boolean {
  return scope === 'uncommitted' || scope === 'unstaged'
}

/** Where a comment is being composed — carries the file path so the all-files
 *  review view can compose on any file without line-number collisions. */
type ComposeTarget = { path: string; anchor: CommentAnchor }

/**
 * Where a review comment is being composed / anchored. 'new' = an added or
 * context line (new-file line number); 'old' = a DELETED line (old-file line
 * number, with its content so we can quote it); 'file' = the file as a whole.
 */
type CommentAnchor =
  | { kind: 'new'; line: number }
  | { kind: 'old'; line: number; content: string }
  | { kind: 'file' }

/** A binary/media file (image or PDF) gets a preview instead of a text diff. */
function isMediaFile(path: string): boolean {
  const k = mediaKind(path)
  return k === 'image' || k === 'pdf'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function DiffView({ sessionId }: { sessionId: string }): JSX.Element {
  const session = useHang4r((s) => s.sessions.find((x) => x.id === sessionId))
  const sendReview = useHang4r((s) => s.sendReview)

  const [files, setFiles] = useState<ChangedFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [diffText, setDiffText] = useState('')
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [composing, setComposing] = useState<ComposeTarget | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Cursor-style review scopes + all-files inline review. Worktrees default to
  // the branch's OWN commits (baseRef...HEAD) — that's exactly what the PR
  // contains and excludes any auto-merged base, so it matches what the user
  // pushed. "All Changes" (vs base, incl. merges) and the dirt scopes stay one
  // click away. Local sessions have no branch base, so they default to the
  // working-tree diff.
  const [scope, setScope] = useState<DiffScope>(
    session?.environment === 'worktree' ? 'branch' : 'uncommitted'
  )
  const [scopes, setScopes] = useState<ScopeSummary[]>([])
  const [adds, setAdds] = useState(0)
  const [dels, setDels] = useState(0)
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [reviewAll, setReviewAll] = useState(false)

  // diff-viewer options (Cursor/VS Code diff toolbar — image 41)
  const [layout, setLayout] = useState<'unified' | 'split'>('unified')
  const [ignoreWs, setIgnoreWs] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [collapse, setCollapse] = useState(false)
  const [find, setFind] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatch, setActiveMatch] = useState(0)
  const stepMatch = (dir: number): void => {
    if (matchCount === 0) return
    setActiveMatch((a) => (a + dir + matchCount) % matchCount)
  }
  useEffect(() => {
    if (activeMatch >= matchCount) setActiveMatch(0)
  }, [matchCount, activeMatch])
  const [menuOpen, setMenuOpen] = useState(false)

  const bumpGit = useHang4r((s) => s.bumpGit)
  const runAction = async (label: string, fn: () => Promise<string | null | void>): Promise<void> => {
    setBusy(true)
    setActionMsg(null)
    try {
      const result = await fn()
      setActionMsg(typeof result === 'string' && result ? `${label}: ${result}` : `${label} ✓`)
      await refresh()
      bumpGit()
    } catch (err) {
      setActionMsg(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const refresh = async (nextScope: DiffScope = scope): Promise<void> => {
    setLoading(true)
    try {
      const [summary, sf] = await Promise.all([
        window.hang4r.scopeSummary(sessionId),
        window.hang4r.scopedFiles(sessionId, nextScope)
      ])
      setScopes(summary)
      // if the active scope isn't available here (e.g. Branch Commits on a local
      // session), fall back to Uncommitted, which always applies.
      const entry = summary.find((s) => s.scope === nextScope)
      if (summary.length && entry && !entry.available) {
        setScope('uncommitted')
        return
      }
      setFiles(sf.files)
      setAdds(sf.adds)
      setDels(sf.dels)
      if (sf.files.length && !sf.files.some((f) => f.path === selected)) {
        setSelected(sf.files[0].path)
      } else if (!sf.files.length) {
        setSelected(null)
        setDiffText('')
      }
    } finally {
      setLoading(false)
    }
  }

  // refresh when the session becomes idle (a turn finished) or the scope changes
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.status, scope])

  // explorer "Open Changes" → single-file view of that file's diff here
  const diffToOpen = useHang4r((s) => s.diffToOpen)
  useEffect(() => {
    if (diffToOpen && diffToOpen.sessionId === sessionId) {
      setReviewAll(false)
      setScope('uncommitted')
      void refresh('uncommitted').then(() => setSelected(diffToOpen.path))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffToOpen])

  // composer "Changes N" pill → all-files review of what's about to be committed
  const reviewToOpen = useHang4r((s) => s.reviewToOpen)
  useEffect(() => {
    if (reviewToOpen && reviewToOpen.sessionId === sessionId) {
      setReviewAll(true)
      setScope('uncommitted')
      void refresh('uncommitted')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewToOpen])

  useEffect(() => {
    if (!selected) return
    void window.hang4r.scopedDiff(sessionId, scope, selected, ignoreWs).then(setDiffText)
  }, [sessionId, scope, selected, ignoreWs])

  // bumped after a per-hunk stage/revert so the all-files review rows re-fetch
  const [hunkNonce, setHunkNonce] = useState(0)
  const applyHunk = async (kind: 'revert' | 'stage', patch: string, path: string): Promise<void> => {
    setBusy(true)
    setActionMsg(null)
    try {
      if (kind === 'revert') await window.hang4r.revertHunk(sessionId, path, patch)
      else await window.hang4r.stageHunk(sessionId, path, patch)
      setActionMsg(kind === 'revert' ? 'Hunk reverted ✓' : 'Hunk staged ✓')
      if (path === selected) {
        const d = await window.hang4r.scopedDiff(sessionId, scope, path, ignoreWs)
        setDiffText(d)
      }
      setHunkNonce((n) => n + 1)
      await refresh()
      bumpGit()
    } catch (e) {
      setActionMsg(`${kind} hunk failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // Electron has no window.prompt — comments are composed inline (see DiffHunks).
  // The anchor decides the line number, the quoted prefix, and where the comment
  // renders back; the prefix is baked into the body so the agent sees the context.
  const addComment = (path: string, anchor: CommentAnchor, body: string): void => {
    const text = body.trim()
    if (text) {
      let comment: ReviewComment
      if (anchor.kind === 'file') {
        comment = { path, line: 0, body: `[re: file] ${text}`, anchor: 'file' }
      } else if (anchor.kind === 'old') {
        comment = {
          path,
          line: anchor.line,
          body: `[re: deleted line ${anchor.line} \`${anchor.content}\`] ${text}`,
          anchor: 'old'
        }
      } else {
        comment = { path, line: anchor.line, body: text, anchor: 'new' }
      }
      setComments((c) => [...c, comment])
    }
    setComposing(null)
  }

  const removeComment = (idx: number): void => {
    setComments((c) => c.filter((_, i) => i !== idx))
  }

  const submit = (): void => {
    if (!comments.length) return
    void sendReview(sessionId, comments)
    setComments([])
  }

  // ssh sessions always have an empty baseRef (the remote repo state isn't
  // known up front) but ARE reviewable — scopeSummary/scopedFiles fall back
  // to HEAD for them. Only a genuinely non-repo LOCAL session hides the panel.
  if (!session?.baseRef && session?.environment !== 'ssh') {
    return <div className="diff-empty">This session isn’t a git repo — no diff available.</div>
  }

  const fileComments = comments.filter((c) => c.path === selected)
  const fileLevelComments = fileComments.filter((c) => c.anchor === 'file')
  const lineComments = fileComments.filter((c) => c.anchor !== 'file')
  const selectedFile = files.find((f) => f.path === selected)
  const selectedIsMedia = selected ? isMediaFile(selected) : false

  return (
    <div className="diff-view">
      <div className="diff-files">
        <div className="diff-files-header">
          <div className="diff-scope-wrap">
            <button
              className="diff-scope-btn"
              title="Change what's being reviewed"
              onClick={() => setScopeMenuOpen((o) => !o)}
            >
              {scopeLabel(scope, session?.environment === 'worktree')} <b>{files.length}</b>
              <span className="diff-scope-caret">▾</span>
            </button>
            {scopeMenuOpen && (
              <div className="diff-menu diff-scope-menu" onMouseLeave={() => setScopeMenuOpen(false)}>
                {scopes
                  .filter((s) => s.available)
                  .map((s) => (
                    <button
                      key={s.scope}
                      className={s.scope === scope ? 'diff-menu-on' : ''}
                      onClick={() => {
                        setScope(s.scope)
                        setScopeMenuOpen(false)
                      }}
                    >
                      {s.scope === scope ? '✓ ' : '   '}
                      {scopeLabel(s.scope, session?.environment === 'worktree')}
                      <span className="diff-scope-count">{s.count}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
          <span className="diff-scope-totals">
            <span className="diff-stat-add">+{adds}</span>{' '}
            <span className="diff-stat-del">−{dels}</span>
          </span>
          <div className="diff-actions">
            <button
              className={'ghost-btn' + (reviewAll ? ' diff-reviewall-on' : '')}
              title="Review every changed file inline"
              onClick={() => setReviewAll((v) => !v)}
            >
              Review all
            </button>
            <button
              className="ghost-btn"
              disabled={busy || files.length === 0}
              title="Commit all changes on the session branch"
              onClick={() =>
                runAction('Commit', () =>
                  window.hang4r.commitSession(sessionId, `Review: ${session?.title ?? ''}`)
                )
              }
            >
              Commit
            </button>
            {session?.environment === 'worktree' && (
              <button
                className="ghost-btn"
                disabled={busy}
                title="Squash-merge this session's branch into the base branch"
                onClick={() => runAction('Merge to base', () => window.hang4r.mergeSessionToBase(sessionId))}
              >
                Merge
              </button>
            )}
            <button
              className="ghost-btn"
              disabled={busy}
              title="Push branch and open its PR (creates one if none exists)"
              onClick={() =>
                runAction('PR', async () => {
                  const url = await window.hang4r.createSessionPr(sessionId)
                  // open the PR so it "brings us to the changes" instead of just
                  // printing the link — existing PRs open too, no more error
                  if (url) useHang4r.getState().requestOpenUrl(sessionId, url)
                  return url
                })
              }
            >
              PR
            </button>
            <button className="ghost-btn" onClick={() => void refresh()} title="Refresh">
              ↻
            </button>
          </div>
        </div>
        {actionMsg && <div className="diff-action-msg">{actionMsg}</div>}
        <div className="diff-file-list">
          {files.length === 0 && (
            <div className="diff-files-empty">{loading ? 'Loading…' : 'No changes yet'}</div>
          )}
          {files.map((f) => {
            const n = comments.filter((c) => c.path === f.path).length
            return (
              <button
                key={f.path}
                className={
                  'diff-file-row' +
                  (!reviewAll && f.path === selected ? ' diff-file-row-active' : '')
                }
                onClick={() => {
                  setSelected(f.path)
                  setReviewAll(false)
                }}
              >
                <span className={`diff-status diff-status-${f.status}`}>
                  {STATUS_MARK[f.status]}
                </span>
                <span className="diff-file-path">{f.path}</span>
                {n > 0 && <span className="diff-comment-count">{n}</span>}
                <span className="diff-stat-add">+{f.additions}</span>
                <span className="diff-stat-del">−{f.deletions}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="diff-body">
        {reviewAll ? (
          files.length ? (
            <AllFilesReview
              sessionId={sessionId}
              scope={scope}
              files={files}
              ignoreWs={ignoreWs}
              busy={busy}
              allowHunkOps={scopeAllowsHunkOps(scope)}
              reloadNonce={hunkNonce}
              comments={comments}
              composing={composing}
              onStartComment={(path, anchor) => setComposing({ path, anchor })}
              onCancelComment={() => setComposing(null)}
              onAddComment={(path, anchor, body) => addComment(path, anchor, body)}
              onRevertHunk={(patch, path) => void applyHunk('revert', patch, path)}
              onStageHunk={(patch, path) => void applyHunk('stage', patch, path)}
            />
          ) : (
            <div className="diff-empty">{loading ? 'Loading…' : 'No changes in this scope.'}</div>
          )
        ) : selected ? (
          <>
            <div className="diff-toolbar">
              <span className="diff-toolbar-path">{selected}</span>
              <button
                className="ghost-btn diff-file-comment-btn"
                title="Comment on this file as a whole"
                onClick={() => setComposing({ path: selected, anchor: { kind: 'file' } })}
              >
                <Icon name="message" size={12} /> Comment on file
              </button>
              {findOpen && (
                <span className="diff-find-bar">
                  <input
                    className="diff-find"
                    autoFocus
                    placeholder="Find in changes…"
                    value={find}
                    onChange={(e) => {
                      setFind(e.target.value)
                      setActiveMatch(0)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setFindOpen(false)
                        setFind('')
                      } else if (e.key === 'Enter') {
                        e.preventDefault()
                        stepMatch(e.shiftKey ? -1 : 1)
                      }
                    }}
                  />
                  {find.trim() && (
                    <span className="diff-find-count">
                      {matchCount ? `${activeMatch + 1} of ${matchCount}` : 'No results'}
                    </span>
                  )}
                  <button
                    className="ghost-btn diff-find-nav"
                    title="Previous match (⇧⏎)"
                    disabled={matchCount === 0}
                    onClick={() => stepMatch(-1)}
                  >
                    ↑
                  </button>
                  <button
                    className="ghost-btn diff-find-nav"
                    title="Next match (⏎)"
                    disabled={matchCount === 0}
                    onClick={() => stepMatch(1)}
                  >
                    ↓
                  </button>
                </span>
              )}
              <div className="diff-toolbar-menu-wrap">
                <button
                  className="ghost-btn diff-toolbar-btn"
                  title="Diff options"
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <div className="diff-menu" onMouseLeave={() => setMenuOpen(false)}>
                    <div className="diff-menu-label">Layout</div>
                    <button
                      className={layout === 'unified' ? 'diff-menu-on' : ''}
                      onClick={() => {
                        setLayout('unified')
                        setMenuOpen(false)
                      }}
                    >
                      {layout === 'unified' ? '✓ ' : '   '}Unified
                    </button>
                    <button
                      className={layout === 'split' ? 'diff-menu-on' : ''}
                      onClick={() => {
                        setLayout('split')
                        setMenuOpen(false)
                      }}
                    >
                      {layout === 'split' ? '✓ ' : '   '}Split
                    </button>
                    <div className="diff-menu-sep" />
                    <button onClick={() => setIgnoreWs((v) => !v)}>
                      {ignoreWs ? '✓ ' : '   '}Ignore whitespace
                    </button>
                    <button onClick={() => setWordWrap((v) => !v)}>
                      {wordWrap ? '✓ ' : '   '}Word wrap
                    </button>
                    <button onClick={() => setCollapse((v) => !v)}>
                      {collapse ? '✓ ' : '   '}Collapse unchanged
                    </button>
                    <div className="diff-menu-sep" />
                    <button
                      onClick={() => {
                        setFindOpen((v) => !v)
                        setMenuOpen(false)
                      }}
                    >
                      Find in changes
                    </button>
                    <button
                      onClick={() => {
                        void refresh()
                        setMenuOpen(false)
                      }}
                    >
                      Refresh changes
                    </button>
                  </div>
                )}
              </div>
            </div>
            <FileCommentSection
              comments={fileLevelComments}
              composing={composing?.path === selected && composing.anchor.kind === 'file'}
              onCancel={() => setComposing(null)}
              onAdd={(body) => addComment(selected, { kind: 'file' }, body)}
            />
            {selectedIsMedia ? (
              <MediaDiffView
                sessionId={sessionId}
                path={selected}
                status={selectedFile?.status ?? 'modified'}
              />
            ) : (
              <DiffHunks
                path={selected}
                diffText={diffText}
                layout={layout}
                wordWrap={wordWrap}
                collapse={collapse}
                find={find}
                activeMatch={activeMatch}
                onMatchCount={setMatchCount}
                busy={busy}
                allowHunkOps={scopeAllowsHunkOps(scope)}
                onRevertHunk={(patch) => void applyHunk('revert', patch, selected)}
                onStageHunk={(patch) => void applyHunk('stage', patch, selected)}
                comments={lineComments}
                composing={composing?.path === selected ? composing.anchor : null}
                onStartComment={(anchor) => setComposing({ path: selected, anchor })}
                onCancelComment={() => setComposing(null)}
                onAddComment={(anchor, body) => addComment(selected, anchor, body)}
              />
            )}
          </>
        ) : (
          <div className="diff-empty">Select a file to review.</div>
        )}
      </div>

      {comments.length > 0 && (
        <div className="review-bar">
          <div className="review-comments">
            {comments.map((c, i) => (
              <span key={i} className="review-chip" onClick={() => removeComment(i)}>
                {c.path.split('/').pop()}:{c.anchor === 'file' ? 'file' : c.line} ×
              </span>
            ))}
          </div>
          <button className="primary-btn" onClick={submit}>
            Send review ({comments.length}) to agent
          </button>
        </div>
      )}
    </div>
  )
}

/** Callbacks the all-files review threads down to each file row (path-scoped). */
interface AllFilesCallbacks {
  onStartComment: (path: string, anchor: CommentAnchor) => void
  onCancelComment: () => void
  onAddComment: (path: string, anchor: CommentAnchor, body: string) => void
  onRevertHunk: (patch: string, path: string) => void
  onStageHunk: (patch: string, path: string) => void
}

/**
 * Cursor's "review all files" surface: every changed file in the scope as a
 * collapsible row (collapsed shows path + ±counts; expanded renders the inline
 * diff via the SAME DiffHunks renderer, with unchanged-line folds on).
 */
function AllFilesReview({
  sessionId,
  scope,
  files,
  ignoreWs,
  busy,
  allowHunkOps,
  reloadNonce,
  comments,
  composing,
  onStartComment,
  onCancelComment,
  onAddComment,
  onRevertHunk,
  onStageHunk
}: {
  sessionId: string
  scope: DiffScope
  files: ChangedFile[]
  ignoreWs: boolean
  busy: boolean
  allowHunkOps: boolean
  reloadNonce: number
  comments: ReviewComment[]
  composing: ComposeTarget | null
} & AllFilesCallbacks): JSX.Element {
  return (
    <div className="review-all">
      {files.map((f) => (
        <FileReviewRow
          key={f.path}
          sessionId={sessionId}
          scope={scope}
          file={f}
          ignoreWs={ignoreWs}
          busy={busy}
          allowHunkOps={allowHunkOps}
          reloadNonce={reloadNonce}
          comments={comments.filter((c) => c.path === f.path)}
          composing={composing?.path === f.path ? composing.anchor : null}
          onStartComment={(anchor) => onStartComment(f.path, anchor)}
          onCancelComment={onCancelComment}
          onAddComment={(anchor, body) => onAddComment(f.path, anchor, body)}
          onRevertHunk={(patch) => onRevertHunk(patch, f.path)}
          onStageHunk={(patch) => onStageHunk(patch, f.path)}
        />
      ))}
    </div>
  )
}

/** One collapsible file row in the all-files review; loads its patch on expand. */
function FileReviewRow({
  sessionId,
  scope,
  file,
  ignoreWs,
  busy,
  allowHunkOps,
  reloadNonce,
  comments,
  composing,
  onStartComment,
  onCancelComment,
  onAddComment,
  onRevertHunk,
  onStageHunk
}: {
  sessionId: string
  scope: DiffScope
  file: ChangedFile
  ignoreWs: boolean
  busy: boolean
  allowHunkOps: boolean
  reloadNonce: number
  comments: ReviewComment[]
  composing: CommentAnchor | null
  onStartComment: (anchor: CommentAnchor) => void
  onCancelComment: () => void
  onAddComment: (anchor: CommentAnchor, body: string) => void
  onRevertHunk: (patch: string) => void
  onStageHunk: (patch: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [diffText, setDiffText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const isMedia = isMediaFile(file.path)
  const fileLevel = comments.filter((c) => c.anchor === 'file')
  const lineComments = comments.filter((c) => c.anchor !== 'file')

  // (re)load the patch when expanded, and whenever the scope / whitespace / a
  // per-hunk stage-or-revert (reloadNonce) changes what the diff should show.
  useEffect(() => {
    if (!open || isMedia) return
    let cancelled = false
    void window.hang4r.scopedDiff(sessionId, scope, file.path, ignoreWs).then((d) => {
      if (!cancelled) {
        setDiffText(d)
        setLoaded(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, isMedia, sessionId, scope, file.path, ignoreWs, reloadNonce])

  return (
    <div className={'review-file' + (open ? ' review-file-open' : '')}>
      <button className="review-file-head" onClick={() => setOpen((o) => !o)}>
        <span className="review-file-caret">{open ? '▾' : '▸'}</span>
        <span className={`diff-status diff-status-${file.status}`}>{STATUS_MARK[file.status]}</span>
        <span className="diff-file-path">{file.path}</span>
        {comments.length > 0 && <span className="diff-comment-count">{comments.length}</span>}
        <span className="diff-stat-add">+{file.additions}</span>
        <span className="diff-stat-del">−{file.deletions}</span>
      </button>
      {open && (
        <div className="review-file-body">
          <div className="review-file-tools">
            <button
              className="ghost-btn diff-file-comment-btn"
              title="Comment on this file as a whole"
              onClick={() => onStartComment({ kind: 'file' })}
            >
              <Icon name="message" size={12} /> Comment on file
            </button>
          </div>
          <FileCommentSection
            comments={fileLevel}
            composing={composing?.kind === 'file'}
            onCancel={onCancelComment}
            onAdd={(body) => onAddComment({ kind: 'file' }, body)}
          />
          {isMedia ? (
            <MediaDiffView sessionId={sessionId} path={file.path} status={file.status} />
          ) : !loaded ? (
            <div className="diff-empty">Loading…</div>
          ) : (
            <DiffHunks
              path={file.path}
              diffText={diffText}
              layout="unified"
              wordWrap={false}
              collapse={true}
              hideTitle
              find=""
              activeMatch={0}
              onMatchCount={() => {}}
              busy={busy}
              allowHunkOps={allowHunkOps}
              onRevertHunk={onRevertHunk}
              onStageHunk={onStageHunk}
              comments={lineComments}
              composing={composing}
              onStartComment={onStartComment}
              onCancelComment={onCancelComment}
              onAddComment={onAddComment}
            />
          )}
        </div>
      )}
    </div>
  )
}

interface Row {
  type: 'add' | 'del' | 'normal' | 'hunk'
  content: string
  newLine?: number
  oldLine?: number
}

interface Hunk {
  header: string
  patch: string
  rows: Row[]
}

/** shared find state threaded through render so matches get a stable global index */
interface FindCtx {
  find: string
  counter: { n: number } // incremented per match, in render order
  active: number // global index of the highlighted match
  activeRef: (el: HTMLElement | null) => void
}

/** highlight ALL `find` matches inside a diff line; tag the active one */
function withFind(content: string, fc: FindCtx): JSX.Element | string {
  const f = fc.find.trim().toLowerCase()
  if (!f) return content
  const lc = content.toLowerCase()
  const parts: (string | JSX.Element)[] = []
  let last = 0
  let idx = lc.indexOf(f, 0)
  let k = 0
  while (idx !== -1) {
    if (idx > last) parts.push(content.slice(last, idx))
    const gi = fc.counter.n++
    const isActive = gi === fc.active
    parts.push(
      <mark
        key={k++}
        ref={isActive ? fc.activeRef : undefined}
        className={'diff-find-hit' + (isActive ? ' diff-find-active' : '')}
      >
        {content.slice(idx, idx + fc.find.length)}
      </mark>
    )
    last = idx + fc.find.length
    idx = lc.indexOf(f, last)
  }
  if (last < content.length) parts.push(content.slice(last))
  return <>{parts}</>
}

function DiffHunks({
  path,
  diffText,
  layout,
  wordWrap,
  collapse,
  find,
  activeMatch,
  onMatchCount,
  busy,
  allowHunkOps = true,
  hideTitle = false,
  onRevertHunk,
  onStageHunk,
  comments,
  composing,
  onStartComment,
  onCancelComment,
  onAddComment
}: {
  path: string
  diffText: string
  layout: 'unified' | 'split'
  wordWrap: boolean
  collapse: boolean
  find: string
  activeMatch: number
  onMatchCount: (n: number) => void
  busy: boolean
  allowHunkOps?: boolean
  hideTitle?: boolean
  onRevertHunk: (patch: string) => void
  onStageHunk: (patch: string) => void
  comments: ReviewComment[]
  composing: CommentAnchor | null
  onStartComment: (anchor: CommentAnchor) => void
  onCancelComment: () => void
  onAddComment: (anchor: CommentAnchor, body: string) => void
}): JSX.Element {
  const { fileHeader, hunks } = useMemo(() => parseHunks(diffText), [diffText])
  // line comments are keyed by side + line ('new:N' for added/context lines,
  // 'old:N' for deleted lines) so a deleted line's comment doesn't collide with
  // the same-numbered new line.
  const commentsByAnchor = useMemo(() => {
    const m = new Map<string, ReviewComment[]>()
    for (const c of comments) {
      const key = `${c.anchor ?? 'new'}:${c.line}`
      const list = m.get(key) ?? []
      list.push(c)
      m.set(key, list)
    }
    return m
  }, [comments])

  // find state threaded into the renderers: a per-render counter assigns each
  // match a global index; the active one gets a ref so we can scroll to it.
  const counter = { n: 0 }
  const activeMarkRef = useRef<HTMLElement | null>(null)
  const fc: FindCtx = {
    find,
    counter,
    active: activeMatch,
    activeRef: (el) => (activeMarkRef.current = el)
  }
  // after render, report the total match count and scroll to the active match
  useEffect(() => {
    onMatchCount(counter.n)
    if (find.trim() && activeMarkRef.current) {
      activeMarkRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    // counter.n reflects this render's total; re-run when inputs change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, activeMatch, diffText, layout, collapse])

  if (!hunks.length) {
    return <div className="diff-empty">No textual diff (binary or empty).</div>
  }

  const wrapClass = wordWrap ? ' diff-wrap' : ''

  // one comment-callback bundle, shared verbatim by the unified AND split
  // renderers so both views drive the exact same comment state/logic.
  const cb: CommentCallbacks = {
    commentsByAnchor,
    composing,
    onStartComment,
    onCancelComment,
    onAddComment
  }

  return (
    <div className={'diff-hunks' + wrapClass}>
      {!hideTitle && <div className="diff-file-title">{path}</div>}
      {hunks.map((hunk, hi) => (
        <div key={hi} className="diff-hunk">
          <div className="diff-hunk-head">
            <span className="diff-hunk-range">{hunk.header}</span>
            {allowHunkOps && (
              <span className="diff-hunk-actions">
                <button
                  className="diff-hunk-btn"
                  disabled={busy}
                  title="Stage this hunk"
                  onClick={() => onStageHunk(fileHeader + hunk.patch)}
                >
                  + Stage
                </button>
                <button
                  className="diff-hunk-btn diff-hunk-revert"
                  disabled={busy}
                  title="Revert this hunk in the working tree"
                  onClick={() => onRevertHunk(fileHeader + hunk.patch)}
                >
                  ↩ Revert
                </button>
              </span>
            )}
          </div>
          <table className="diff-table">
            <tbody>
              {(layout === 'split'
                ? renderSplit(hunk.rows, collapse, fc, cb)
                : renderUnified(hunk.rows, collapse, fc, cb))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

/** collapse long runs of unchanged rows into a "⋯ N unchanged" band */
function collapseRows(rows: Row[], enabled: boolean): (Row | { band: number })[] {
  if (!enabled) return rows
  const CTX = 3
  const out: (Row | { band: number })[] = []
  let run: Row[] = []
  const flush = (): void => {
    if (run.length > CTX * 2 + 1) {
      out.push(...run.slice(0, CTX))
      out.push({ band: run.length - CTX * 2 })
      out.push(...run.slice(run.length - CTX))
    } else {
      out.push(...run)
    }
    run = []
  }
  for (const r of rows) {
    if (r.type === 'normal') run.push(r)
    else {
      flush()
      out.push(r)
    }
  }
  flush()
  return out
}

/** The comment state + callbacks that BOTH renderers thread through, so the
 *  unified and split views share one implementation of the commenting feature. */
interface CommentCallbacks {
  commentsByAnchor: Map<string, ReviewComment[]>
  composing: CommentAnchor | null
  onStartComment: (anchor: CommentAnchor) => void
  onCancelComment: () => void
  onAddComment: (anchor: CommentAnchor, body: string) => void
}

/** A line-level anchor (never the whole-file 'file' kind) — what a diff row can carry. */
type LineAnchor = Extract<CommentAnchor, { kind: 'old' | 'new' }>

/**
 * Where a diff row anchors a comment: deleted lines anchor to the OLD-file line
 * number and quote their content; everything else (added/context) anchors to
 * the NEW-file line. Returns null for rows with no line number to anchor to.
 * Shared by both renderers so the anchor semantics never diverge.
 */
function rowAnchor(row: Row): LineAnchor | null {
  return row.type === 'del'
    ? row.oldLine
      ? { kind: 'old', line: row.oldLine, content: row.content }
      : null
    : row.newLine
      ? { kind: 'new', line: row.newLine }
      : null
}

/** The hover "+" affordance that opens the composer for a row's anchor. */
function commentButton(anchor: LineAnchor, cb: CommentCallbacks): JSX.Element {
  const isDel = anchor.kind === 'old'
  return (
    <button
      className="diff-comment-btn"
      title={isDel ? 'Comment on this deleted line' : 'Comment on this line'}
      onClick={() => cb.onStartComment(anchor)}
    >
      +
    </button>
  )
}

/**
 * The extra table rows that hang under a diff row for a given anchor: any
 * existing comments (as full-width cells) followed by the inline composer when
 * this anchor is the one being composed. `cols` is the table's column count
 * (3 unified, 4 split) so the cell spans the full width in either layout.
 */
function commentRows(
  anchor: LineAnchor | null,
  keyBase: string,
  cols: number,
  cb: CommentCallbacks
): JSX.Element[] {
  if (!anchor) return []
  const out: JSX.Element[] = []
  const existing = cb.commentsByAnchor.get(`${anchor.kind}:${anchor.line}`)
  existing?.forEach((c, j) =>
    out.push(
      <tr key={`${keyBase}-c${j}`} className="diff-row-comment">
        <td className="diff-gutter" />
        <td className="diff-comment-cell" colSpan={cols - 1}>
          <Icon name="message" size={12} /> {c.body}
        </td>
      </tr>
    )
  )
  if (
    cb.composing &&
    cb.composing.kind === anchor.kind &&
    'line' in cb.composing &&
    cb.composing.line === anchor.line
  ) {
    out.push(
      <tr key={`${keyBase}-compose`} className="diff-row-compose">
        <td className="diff-gutter" />
        <td className="diff-compose-cell" colSpan={cols - 1}>
          <CommentComposer
            label={anchor.kind === 'old' ? `deleted line ${anchor.line}` : `line ${anchor.line}`}
            onSubmit={(body) => cb.onAddComment(anchor, body)}
            onCancel={cb.onCancelComment}
          />
        </td>
      </tr>
    )
  }
  return out
}

function renderUnified(
  rows: Row[],
  collapse: boolean,
  fc: FindCtx,
  cb: CommentCallbacks
): JSX.Element[] {
  const items = collapseRows(rows, collapse)
  const out: JSX.Element[] = []
  items.forEach((row, i) => {
    if ('band' in row) {
      out.push(
        <tr key={`b${i}`} className="diff-row-band">
          <td className="diff-gutter" />
          <td className="diff-line" colSpan={2}>
            ⋯ {row.band} unchanged lines
          </td>
        </tr>
      )
      return
    }
    const anchor = rowAnchor(row)
    const gutterLine = row.type === 'del' ? row.oldLine : row.newLine
    out.push(
      <tr key={i} className={`diff-row diff-row-${row.type}`}>
        <td className="diff-gutter">
          {gutterLine ?? ''}
          {anchor && commentButton(anchor, cb)}
        </td>
        <td className="diff-sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</td>
        <td className="diff-line">{withFind(row.content, fc)}</td>
      </tr>
    )
    out.push(...commentRows(anchor, String(i), 3, cb))
  })
  return out
}

function renderSplit(
  rows: Row[],
  collapse: boolean,
  fc: FindCtx,
  cb: CommentCallbacks
): JSX.Element[] {
  const items = collapseRows(rows, collapse)
  const out: JSX.Element[] = []
  items.forEach((row, i) => {
    if ('band' in row) {
      out.push(
        <tr key={`b${i}`} className="diff-row-band">
          <td className="diff-gutter" />
          <td className="diff-line" colSpan={3}>
            ⋯ {row.band} unchanged lines
          </td>
        </tr>
      )
      return
    }
    const left = row.type === 'add' ? '' : row.content
    const right = row.type === 'del' ? '' : row.content
    // same anchor semantics as unified: deletions comment on the OLD (left)
    // side, additions/context on the NEW (right) side — the "+" lives in the
    // gutter of whichever side owns the anchor.
    const anchor = rowAnchor(row)
    const leftAnchor = row.type === 'del' ? anchor : null
    const rightAnchor = row.type === 'del' ? null : anchor
    out.push(
      <tr key={i} className="diff-row-split">
        <td className="diff-gutter">
          {row.oldLine ?? ''}
          {leftAnchor && commentButton(leftAnchor, cb)}
        </td>
        <td className={'diff-line diff-split-left' + (row.type === 'del' ? ' diff-row-del' : '')}>
          {withFind(left, fc)}
        </td>
        <td className="diff-gutter">
          {row.newLine ?? ''}
          {rightAnchor && commentButton(rightAnchor, cb)}
        </td>
        <td className={'diff-line diff-split-right' + (row.type === 'add' ? ' diff-row-add' : '')}>
          {withFind(right, fc)}
        </td>
      </tr>
    )
    out.push(...commentRows(anchor, String(i), 4, cb))
  })
  return out
}

function CommentComposer({
  label,
  onSubmit,
  onCancel
}: {
  label: string
  onSubmit: (body: string) => void
  onCancel: () => void
}): JSX.Element {
  const [body, setBody] = useState('')
  return (
    <div className="comment-composer">
      <textarea
        className="comment-composer-input"
        autoFocus
        placeholder={`Comment on ${label}… (⏎ to add, Esc to cancel)`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSubmit(body)
          } else if (e.key === 'Escape') {
            onCancel()
          }
        }}
      />
      <div className="comment-composer-actions">
        <button className="ghost-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary-btn" disabled={!body.trim()} onClick={() => onSubmit(body)}>
          Add comment
        </button>
      </div>
    </div>
  )
}

/**
 * Whole-file review comments + composer, shown above the diff/media body. This
 * is the only way to comment on a binary or fully-deleted file (no lines to
 * anchor to), and complements per-line commenting for everything else.
 */
function FileCommentSection({
  comments,
  composing,
  onCancel,
  onAdd
}: {
  comments: ReviewComment[]
  composing: boolean
  onCancel: () => void
  onAdd: (body: string) => void
}): JSX.Element | null {
  if (!comments.length && !composing) return null
  return (
    <div className="diff-file-comments">
      {comments.map((c, i) => (
        <div key={i} className="diff-file-comment">
          <Icon name="message" size={12} /> {c.body}
        </div>
      ))}
      {composing && (
        <div className="diff-file-compose">
          <CommentComposer label="this file" onSubmit={onAdd} onCancel={onCancel} />
        </div>
      )}
    </div>
  )
}

/**
 * Before/after preview for a changed binary/media file (images, PDF). Modified
 * files show both sides; added files show only the new preview; deleted files
 * show the old preview greyed with a "deleted" badge. Payloads over the preview
 * cap fall back to a "too large" note.
 */
function MediaDiffView({
  sessionId,
  path,
  status
}: {
  sessionId: string
  path: string
  status: ChangedFile['status']
}): JSX.Element {
  const [data, setData] = useState<MediaDiff | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setData(null)
    window.hang4r
      .getMediaDiff(sessionId, path)
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, path])

  if (loading) return <div className="media-empty">Loading preview…</div>
  const kind = mediaKind(path) // 'image' | 'pdf'
  const before = data?.before ?? null
  const after = data?.after ?? null
  if (!before && !after) {
    return <div className="media-empty">No preview available for this file.</div>
  }
  return (
    <div className="media-diff">
      <div className="media-diff-panes">
        {before && (
          <MediaDiffPane side={before} kind={kind} label="Before" deleted={status === 'deleted'} />
        )}
        {after && (
          <MediaDiffPane side={after} kind={kind} label={status === 'added' ? 'Added' : 'After'} />
        )}
      </div>
    </div>
  )
}

function MediaDiffPane({
  side,
  kind,
  label,
  deleted
}: {
  side: MediaSide
  kind: 'image' | 'pdf' | 'markdown' | 'html' | 'code'
  label: string
  deleted?: boolean
}): JSX.Element {
  return (
    <div className={'media-diff-pane' + (deleted ? ' media-diff-deleted' : '')}>
      <div className="media-diff-label">
        <span>{label}</span>
        {deleted && <span className="media-diff-badge">deleted</span>}
        <span className="media-diff-size">{formatBytes(side.size)}</span>
      </div>
      <div className="media-diff-preview">
        {side.tooLarge ? (
          <div className="media-empty">Too large to preview ({formatBytes(side.size)}).</div>
        ) : kind === 'pdf' ? (
          <embed src={side.dataUrl} type="application/pdf" width="100%" height="100%" />
        ) : (
          <img src={side.dataUrl} alt={label} />
        )}
      </div>
    </div>
  )
}

/**
 * Split a unified diff into the file header (diff --git / --- / +++) and a list
 * of hunks, each carrying its raw patch text (for per-hunk stage/revert) and its
 * parsed rows (for rendering). Uses parse-diff for row structure and the raw
 * text for exact patch reconstruction.
 */
function parseHunks(diffText: string): { fileHeader: string; hunks: Hunk[] } {
  if (!diffText.trim()) return { fileHeader: '', hunks: [] }
  const lines = diffText.split('\n')
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'))
  if (firstHunk === -1) return { fileHeader: '', hunks: [] }
  const fileHeader = lines.slice(0, firstHunk).join('\n') + '\n'

  // split raw hunk texts
  const rawHunks: string[] = []
  let cur: string[] = []
  for (let i = firstHunk; i < lines.length; i++) {
    if (lines[i].startsWith('@@') && cur.length) {
      rawHunks.push(cur.join('\n'))
      cur = []
    }
    cur.push(lines[i])
  }
  if (cur.length) rawHunks.push(cur.join('\n'))

  let parsed: parseDiff.File[] = []
  try {
    parsed = parseDiff(diffText)
  } catch {
    parsed = []
  }
  const chunks = parsed[0]?.chunks ?? []

  const hunks: Hunk[] = rawHunks.map((raw, i) => {
    const chunk = chunks[i]
    const rows: Row[] = []
    if (chunk) {
      for (const change of chunk.changes) {
        const type = change.type === 'add' ? 'add' : change.type === 'del' ? 'del' : 'normal'
        const c = change as { ln?: number; ln1?: number; ln2?: number }
        const newLine = c.ln2 ?? (change.type !== 'del' ? c.ln : undefined)
        const oldLine = c.ln1 ?? (change.type !== 'add' ? c.ln : undefined)
        rows.push({ type, content: change.content.replace(/^[+\- ]/, ''), newLine, oldLine })
      }
    }
    return { header: chunk?.content ?? raw.split('\n')[0], patch: raw + '\n', rows }
  })
  return { fileHeader, hunks }
}
