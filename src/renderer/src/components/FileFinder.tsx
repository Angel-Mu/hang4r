import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useHang4r } from '../state/store'

/**
 * ⌘P quick file finder — fuzzy-search every file in the focused session's
 * workspace and open it in the Files panel. Subsequence fuzzy match with
 * word-boundary / basename bonuses (VS Code-style), highlighted matches.
 */
export function FileFinder(): JSX.Element | null {
  const open = useHang4r((s) => s.fileFinderOpen)
  const close = useHang4r((s) => s.toggleFileFinder)
  const focused = useHang4r((s) => s.focusedSessionId)
  const requestOpenFile = useHang4r((s) => s.requestOpenFile)

  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || !focused) return
    setQuery('')
    setActive(0)
    void window.hang4r.listAllFiles(focused).then(setFiles)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open, focused])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return files.slice(0, 50).map((path) => ({ path, ranges: [] as number[][] }))
    const tokens = q.split(/\s+/)
    const scored: { path: string; score: number; ranges: number[][] }[] = []
    for (const path of files) {
      const lower = path.toLowerCase()
      // all tokens must match (AND)
      if (!tokens.every((t) => subseq(lower, t))) continue
      const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
      const { score, ranges } = scoreMatch(path, lower, base, tokens[tokens.length - 1])
      scored.push({ path, score, ranges })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 50)
  }, [files, query])

  useEffect(() => setActive(0), [query])

  if (!open) return null
  if (!focused) return null

  const choose = (path?: string): void => {
    if (!path) return
    close(false)
    requestOpenFile(focused, path)
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search files by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(results[active]?.path)
            } else if (e.key === 'Escape') {
              close(false)
            }
          }}
        />
        <div className="palette-list">
          {results.length === 0 && <div className="palette-empty">No files match</div>}
          {results.map((r, i) => {
            const slash = r.path.lastIndexOf('/')
            const dir = slash >= 0 ? r.path.slice(0, slash) : ''
            const base = slash >= 0 ? r.path.slice(slash + 1) : r.path
            return (
              <button
                key={r.path}
                className={'palette-item finder-item' + (i === active ? ' palette-item-active' : '')}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r.path)}
              >
                <span className="finder-name">{highlight(base, r.ranges, r.path.length - base.length)}</span>
                {dir && <span className="finder-dir">{dir}</span>}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function subseq(text: string, q: string): boolean {
  let i = 0
  for (let c = 0; c < text.length && i < q.length; c++) if (text[c] === q[i]) i++
  return i === q.length
}

/** basename-weighted subsequence score with word-boundary + consecutive bonuses */
function scoreMatch(path: string, lower: string, base: string, q: string): { score: number; ranges: number[][] } {
  let score = 0
  let qi = 0
  let prevMatch = -2
  const ranges: number[][] = []
  const baseStart = path.length - base.length
  for (let c = 0; c < lower.length && qi < q.length; c++) {
    if (lower[c] === q[qi]) {
      let s = 1
      if (c === prevMatch + 1) s += 4 // consecutive
      if (c === 0 || '/._- '.includes(lower[c - 1])) s += 6 // boundary
      if (c >= baseStart) s += 4 // in basename
      score += s
      ranges.push([c, c + 1])
      prevMatch = c
      qi++
    }
  }
  if (qi < q.length) return { score: -1, ranges: [] }
  return { score, ranges }
}

/** render basename with matched chars (that fall inside it) bolded */
function highlight(base: string, ranges: number[][], baseOffset: number): JSX.Element[] {
  const inBase = new Set<number>()
  for (const [a] of ranges) if (a >= baseOffset) inBase.add(a - baseOffset)
  return base.split('').map((ch, i) =>
    inBase.has(i) ? (
      <b key={i} className="finder-hit">
        {ch}
      </b>
    ) : (
      <span key={i}>{ch}</span>
    )
  )
}
