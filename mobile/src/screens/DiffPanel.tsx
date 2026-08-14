import { useEffect, useState, type JSX } from 'react'
import type { DiffScope, ReviewComment, ScopeSummary, ScopedFiles } from '@shared/protocol'
import { bridge } from '../state/store'

const SCOPE_LABEL: Record<DiffScope, string> = {
  lastTurn: 'Last turn',
  uncommitted: 'Uncommitted',
  unstaged: 'Unstaged',
  staged: 'Staged',
  branch: 'Branch'
}

/** Rows carry their NEW-file line number so a tap can anchor a review
 *  comment exactly where the desktop's submitReview expects it. */
function DiffText({
  patch,
  commentedLines,
  onTapLine
}: {
  patch: string
  commentedLines: Set<number>
  onTapLine: (line: number) => void
}): JSX.Element {
  let newLine = 0
  return (
    <pre className="diff-view">
      {patch.split('\n').map((line, i) => {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
        if (hunk) {
          newLine = parseInt(hunk[1], 10)
          return (
            <div key={i} className="diff-hunk">
              {line}
            </div>
          )
        }
        const isAdd = line.startsWith('+')
        const isDel = line.startsWith('-')
        const cls = isAdd ? 'diff-add' : isDel ? 'diff-del' : ''
        const thisLine = !isDel ? newLine : 0
        if (!isDel) newLine++
        const commentable = thisLine > 0
        return (
          <div
            key={i}
            className={
              cls +
              (commentable ? ' diff-line-tappable' : '') +
              (commentable && commentedLines.has(thisLine) ? ' diff-line-commented' : '')
            }
            onClick={commentable ? () => onTapLine(thisLine) : undefined}
          >
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export function DiffPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const [summary, setSummary] = useState<ScopeSummary[] | null>(null)
  const [scope, setScope] = useState<DiffScope>('uncommitted')
  const [files, setFiles] = useState<ScopedFiles | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [patch, setPatch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [composeLine, setComposeLine] = useState<number | null>(null)
  const [composeText, setComposeText] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const addComment = (): void => {
    if (!openFile || composeLine === null || !composeText.trim()) return
    setComments((c) => [...c, { path: openFile, line: composeLine, body: composeText.trim() }])
    setComposeLine(null)
    setComposeText('')
  }

  const sendReview = async (): Promise<void> => {
    setSending(true)
    setError(null)
    try {
      await bridge().call('submitReview', sessionId, comments)
      setComments([])
      setSent(true)
      setTimeout(() => setSent(false), 2500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(
        msg.includes('unknown method')
          ? 'Review comments need a newer hang4r on your computer — update it and retry.'
          : msg
      )
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    void bridge()
      .call<ScopeSummary[]>('scopeSummary', sessionId)
      .then((sum) => {
        setSummary(sum)
        const preferred = sum.find((s) => s.available && s.count > 0) ?? sum.find((s) => s.available)
        if (preferred) setScope(preferred.scope)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [sessionId])

  useEffect(() => {
    setFiles(null)
    setOpenFile(null)
    void bridge()
      .call<ScopedFiles>('scopedFiles', sessionId, scope)
      .then(setFiles)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [sessionId, scope])

  useEffect(() => {
    if (!openFile) return
    setPatch(null)
    void bridge()
      .call<string>('scopedDiff', sessionId, scope, openFile)
      .then(setPatch)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [sessionId, scope, openFile])

  if (error) return <p className="banner banner-error">{error}</p>

  const reviewBar =
    comments.length > 0 ? (
      <div className="review-bar">
        <span>
          {comments.length} comment{comments.length > 1 ? 's' : ''} pending
        </span>
        <button className="btn btn-primary" disabled={sending} onClick={() => void sendReview()}>
          {sending ? 'Sending…' : 'Send review'}
        </button>
      </div>
    ) : null

  if (openFile) {
    return (
      <div className="diff-panel">
        {reviewBar}
        <button className="btn btn-ghost diff-back" onClick={() => setOpenFile(null)}>
          ‹ {openFile}
        </button>
        {patch === null ? (
          <p className="empty-note">Loading diff…</p>
        ) : patch ? (
          <>
            <p className="diff-comment-hint">Tap a line to comment on it.</p>
            <DiffText
              patch={patch}
              commentedLines={
                new Set(comments.filter((c) => c.path === openFile).map((c) => c.line))
              }
              onTapLine={(line) => {
                setComposeLine(line)
                setComposeText('')
              }}
            />
            {composeLine !== null && (
              <div className="diff-compose">
                <p className="diff-compose-line">Comment on line {composeLine}</p>
                <textarea
                  className="form-field form-textarea"
                  rows={3}
                  autoFocus
                  placeholder="What should the agent change here?"
                  value={composeText}
                  onChange={(e) => setComposeText(e.target.value)}
                />
                <div className="perm-actions">
                  <button className="btn btn-primary" disabled={!composeText.trim()} onClick={addComment}>
                    Add comment
                  </button>
                  <button className="btn" onClick={() => setComposeLine(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="empty-note">No changes in this file.</p>
        )}
      </div>
    )
  }

  return (
    <div className="diff-panel">
      {reviewBar}
      {sent && <p className="banner">Review sent — the agent is on it.</p>}
      <div className="scope-chips">
        {(summary ?? [])
          .filter((s) => s.available)
          .map((s) => (
            <button
              key={s.scope}
              className={'scope-chip' + (s.scope === scope ? ' scope-chip-active' : '')}
              onClick={() => setScope(s.scope)}
            >
              {SCOPE_LABEL[s.scope]} {s.count > 0 && <b>{s.count}</b>}
            </button>
          ))}
      </div>
      {files === null ? (
        <p className="empty-note">Loading…</p>
      ) : files.files.length === 0 ? (
        <p className="empty-note">No changed files in this scope.</p>
      ) : (
        <>
          <p className="diff-totals">
            <span className="diff-add">+{files.adds}</span>{' '}
            <span className="diff-del">−{files.dels}</span>
          </p>
          {files.files.map((f) => (
            <button key={f.path} className="diff-file-row" onClick={() => setOpenFile(f.path)}>
              <span className={`diff-status diff-status-${f.status}`}>
                {f.status[0].toUpperCase()}
              </span>
              <span className="diff-file-path">{f.path}</span>
              <span className="diff-counts">
                <span className="diff-add">+{f.additions}</span>{' '}
                <span className="diff-del">−{f.deletions}</span>
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}
