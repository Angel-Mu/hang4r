import { useEffect, useState, type JSX } from 'react'
import type { DiffScope, ScopeSummary, ScopedFiles } from '@shared/protocol'
import { bridge } from '../state/store'

const SCOPE_LABEL: Record<DiffScope, string> = {
  lastTurn: 'Last turn',
  uncommitted: 'Uncommitted',
  unstaged: 'Unstaged',
  staged: 'Staged',
  branch: 'Branch'
}

function DiffText({ patch }: { patch: string }): JSX.Element {
  return (
    <pre className="diff-view">
      {patch.split('\n').map((line, i) => {
        const cls = line.startsWith('+')
          ? 'diff-add'
          : line.startsWith('-')
            ? 'diff-del'
            : line.startsWith('@@')
              ? 'diff-hunk'
              : ''
        return (
          <div key={i} className={cls}>
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

  if (openFile) {
    return (
      <div className="diff-panel">
        <button className="btn btn-ghost diff-back" onClick={() => setOpenFile(null)}>
          ‹ {openFile}
        </button>
        {patch === null ? (
          <p className="empty-note">Loading diff…</p>
        ) : patch ? (
          <DiffText patch={patch} />
        ) : (
          <p className="empty-note">No changes in this file.</p>
        )}
      </div>
    )
  }

  return (
    <div className="diff-panel">
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
