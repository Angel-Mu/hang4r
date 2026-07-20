import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { SearchMatch, SearchOptions, SearchResults } from '../../../shared/protocol'
import { useHang4r } from '../state/store'
import { fileIcon, type FileIcon } from '../fileIcons'
import { Icon } from './Icon'

/** file-type glyph (SVG when named, else a monochrome text badge) */
function FileGlyph({ fi }: { fi: FileIcon }): JSX.Element {
  return (
    <span className="file-icon" style={{ color: fi.color }}>
      {fi.icon ? <Icon name={fi.icon} size={13} /> : fi.glyph}
    </span>
  )
}

const EMPTY: SearchResults = { files: [], resultCount: 0, fileCount: 0, limitHit: false }

/** query/toggle state per session, kept across unmounts — peeking at another
 *  context tab and coming back must not lose an in-progress search */
interface PanelMemo {
  query: string
  replaceText: string
  matchCase: boolean
  wholeWord: boolean
  isRegex: boolean
  showReplace: boolean
}
const panelMemo = new Map<string, PanelMemo>()

/**
 * Cursor/VS Code-style search-in-files panel with find + replace. Toggles for
 * match-case / whole-word / regex live inside the search field; results are a
 * collapsible tree grouped by file; clicking a match opens the file at its line.
 */
export function SearchPanel({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose?: () => void
}): JSX.Element {
  const memo = panelMemo.get(sessionId)
  const [query, setQuery] = useState(memo?.query ?? '')
  const [replaceText, setReplaceText] = useState(memo?.replaceText ?? '')
  const [matchCase, setMatchCase] = useState(memo?.matchCase ?? false)
  const [wholeWord, setWholeWord] = useState(memo?.wholeWord ?? false)
  const [isRegex, setIsRegex] = useState(memo?.isRegex ?? false)
  const [showReplace, setShowReplace] = useState(memo?.showReplace ?? false)
  const [results, setResults] = useState<SearchResults>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  const options: SearchOptions = { query, isRegex, matchCase, wholeWord }

  // remember panel state for this session so a tab switch restores it
  useEffect(() => {
    panelMemo.set(sessionId, { query, replaceText, matchCase, wholeWord, isRegex, showReplace })
  }, [sessionId, query, replaceText, matchCase, wholeWord, isRegex, showReplace])

  // ⌘⇧F (or the Search tab reopening) → focus + select the query field
  const searchToOpen = useHang4r((s) => s.searchToOpen)
  useEffect(() => {
    if (searchToOpen && searchToOpen.sessionId === sessionId) {
      const el = inputRef.current
      setTimeout(() => {
        el?.focus()
        el?.select()
      }, 0)
    }
  }, [searchToOpen, sessionId])

  // focus on first mount too (the panel just opened)
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const runSearch = useCallback(async (): Promise<void> => {
    if (!query.trim()) {
      setResults(EMPTY)
      return
    }
    setBusy(true)
    try {
      const r = await window.hang4r.searchInFiles(sessionId, { query, isRegex, matchCase, wholeWord })
      setResults(r)
      setCollapsed(new Set())
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, query, isRegex, matchCase, wholeWord])

  // debounce search as you type / toggle options (~250ms)
  useEffect(() => {
    if (!query.trim()) {
      setResults(EMPTY)
      return
    }
    const t = setTimeout(() => void runSearch(), 250)
    return () => clearTimeout(t)
  }, [query, isRegex, matchCase, wholeWord, runSearch])

  const openMatch = (file: string, line: number): void => {
    const store = useHang4r.getState()
    store.focusSession(sessionId)
    store.requestOpenFile(sessionId, file, line)
  }

  const toggleCollapse = (file: string): void => {
    setCollapsed((s) => {
      const n = new Set(s)
      n.has(file) ? n.delete(file) : n.add(file)
      return n
    })
  }

  const replaceScope = async (
    scope: Parameters<typeof window.hang4r.replaceInFiles>[1]['scope']
  ): Promise<void> => {
    setBusy(true)
    try {
      await window.hang4r.replaceInFiles(sessionId, { options, replacement: replaceText, scope })
      useHang4r.getState().bumpGit()
      await runSearch()
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (query) {
        setQuery('')
        setResults(EMPTY)
      } else {
        onClose?.()
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void runSearch()
    }
  }

  const summary = query.trim()
    ? results.resultCount === 0
      ? busy
        ? 'Searching…'
        : 'No results'
      : `${results.resultCount} result${results.resultCount === 1 ? '' : 's'} in ${results.fileCount} file${results.fileCount === 1 ? '' : 's'}` +
        (results.limitHit ? ' (truncated)' : '')
    : ''

  return (
    <div className="search-panel">
      <div className="search-panel-head">
        <button
          className="search-expand"
          title={showReplace ? 'Hide Replace' : 'Toggle Replace'}
          aria-expanded={showReplace}
          onClick={() => setShowReplace((v) => !v)}
        >
          <Icon name={showReplace ? 'chevron-down' : 'chevron-right'} size={13} />
        </button>
        <div className="search-fields">
          <div className="search-field">
            <input
              ref={inputRef}
              className="search-input"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="search-field-toggles">
              <button
                className={'search-toggle' + (matchCase ? ' on' : '')}
                title="Match Case"
                onClick={() => setMatchCase((v) => !v)}
              >
                Aa
              </button>
              <button
                className={'search-toggle' + (wholeWord ? ' on' : '')}
                title="Match Whole Word"
                onClick={() => setWholeWord((v) => !v)}
              >
                <u>ab</u>
              </button>
              <button
                className={'search-toggle' + (isRegex ? ' on' : '')}
                title="Use Regular Expression"
                onClick={() => setIsRegex((v) => !v)}
              >
                .*
              </button>
            </div>
          </div>
          {showReplace && (
            <div className="search-field search-replace-field">
              <input
                className="search-input"
                placeholder="Replace"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (results.resultCount > 0) void replaceScope({ kind: 'all' })
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    onClose?.()
                  }
                }}
              />
              <div className="search-field-toggles">
                <button
                  className="search-toggle search-replace-all"
                  title="Replace All"
                  disabled={results.resultCount === 0 || busy}
                  onClick={() => void replaceScope({ kind: 'all' })}
                >
                  <Icon name="replace-all" size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {summary && <div className="search-summary">{summary}</div>}

      <div className="search-tree">
        {results.files.map((f) => {
          const isCollapsed = collapsed.has(f.file)
          const name = f.file.slice(f.file.lastIndexOf('/') + 1)
          const dir = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : ''
          return (
            <div key={f.file} className="search-group">
              <div className="search-group-head">
                <button className="search-group-toggle" onClick={() => toggleCollapse(f.file)}>
                  <span className="search-caret">
                    <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={11} />
                  </span>
                  <FileGlyph fi={fileIcon(name)} />
                  <span className="search-group-name">{name}</span>
                  {dir && <span className="search-group-dir">{dir}</span>}
                  <span className="search-group-count">{f.matches.length}</span>
                </button>
                {showReplace && (
                  <button
                    className="search-group-replace"
                    title="Replace All in File"
                    disabled={busy}
                    onClick={() => void replaceScope({ kind: 'file', file: f.file })}
                  >
                    ⇄
                  </button>
                )}
              </div>
              {!isCollapsed &&
                f.matches.map((m, i) => (
                  <div key={i} className="search-match-row">
                    <button className="search-match" onClick={() => openMatch(f.file, m.line)}>
                      <MatchText m={m} replaceWith={showReplace ? replaceText : undefined} />
                    </button>
                    {showReplace && (
                      <button
                        className="search-match-replace"
                        title="Replace"
                        disabled={busy}
                        onClick={() =>
                          void replaceScope({
                            kind: 'match',
                            file: f.file,
                            line: m.line,
                            column: m.column
                          })
                        }
                      >
                        →
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** one result line with the matched substring highlighted (+ replace preview) */
function MatchText({ m, replaceWith }: { m: SearchMatch; replaceWith?: string }): JSX.Element {
  const start = Math.max(0, m.matchStart)
  const pre = m.text.slice(0, start)
  const mid = m.text.slice(start, start + m.matchLength)
  const post = m.text.slice(start + m.matchLength)
  return (
    <span className="search-match-text">
      {pre}
      <span className={'search-hl' + (replaceWith ? ' search-hl-removed' : '')}>{mid}</span>
      {replaceWith ? <span className="search-hl-added">{replaceWith}</span> : null}
      {post}
    </span>
  )
}
