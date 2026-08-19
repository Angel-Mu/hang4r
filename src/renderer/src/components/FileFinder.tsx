import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useHang4r } from '../state/store'

/**
 * ⌘P quick file finder — search every file in the focused session's workspace
 * and open it in the Files panel. Ranks exact/prefix/substring basename matches
 * above the fuzzy-subsequence fallback (VS Code-style), highlights the match, and
 * accepts a trailing :line[:col] to jump straight to a line.
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
    void window.hang4r.listAllFiles(focused, true).then(setFiles) // include gitignored user files
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open, focused])

  // strip a trailing :line[:col] (VS Code / Cursor style) so "file.ts:103" both
  // matches the file AND jumps to the line — matching the literal ":103" against
  // filenames found nothing (Angel).
  const { search, gotoLine } = useMemo(() => {
    const raw = query.trim()
    const m = /^(.+?):(\d+)(?::\d+)?$/.exec(raw)
    return m
      ? { search: m[1], gotoLine: Number(m[2]) }
      : { search: raw, gotoLine: undefined as number | undefined }
  }, [query])

  const results = useMemo(() => {
    const q = search.toLowerCase()
    if (!q) return files.slice(0, 50).map((path) => ({ path, ranges: [] as number[][] }))
    const tokens = q.split(/\s+/).filter(Boolean)
    const scored: { path: string; score: number; ranges: number[][] }[] = []
    for (const path of files) {
      const lower = path.toLowerCase()
      // all tokens must match (AND)
      if (!tokens.every((t) => subseq(lower, t))) continue
      const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
      const { score, ranges } = scoreMatch(path, lower, base, tokens)
      scored.push({ path, score, ranges })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 50)
  }, [files, search])

  useEffect(() => setActive(0), [query])

  if (!open) return null
  if (!focused) return null

  const choose = (path?: string): void => {
    if (!path) return
    close(false)
    requestOpenFile(focused, path, gotoLine)
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

/**
 * Rank by tiers so the file you typed the name of wins and its highlight is the
 * contiguous run — not scattered subsequence characters (Angel: the exact match
 * ranked below its `.spec.ts` cousins). Exact basename › basename prefix ›
 * basename substring › path substring › fuzzy subsequence. Shorter paths break
 * ties. `q` is the tokens joined (a single filename fragment in the common case;
 * a multi-word query has no contiguous match and falls through to the fuzzy tier).
 */
function scoreMatch(
  path: string,
  lower: string,
  base: string,
  tokens: string[]
): { score: number; ranges: number[][] } {
  const baseStart = path.length - base.length
  const q = tokens.join('')
  // Tier 1 — exact basename
  if (q && base === q) return { score: 1_000_000 - path.length, ranges: [[baseStart, path.length]] }
  // Tier 2 — contiguous substring of the basename (prefix + word-boundary win)
  const bi = q ? base.indexOf(q) : -1
  if (bi >= 0) {
    const prefix = bi === 0 ? 5000 : 0
    const boundary = bi === 0 || '/._- '.includes(base[bi - 1]) ? 1500 : 0
    return {
      score: 500_000 + prefix + boundary - bi * 10 - path.length,
      ranges: [[baseStart + bi, baseStart + bi + q.length]]
    }
  }
  // Tier 3 — contiguous substring elsewhere in the path
  const pi = q ? lower.indexOf(q) : -1
  if (pi >= 0) return { score: 200_000 - pi * 10 - path.length, ranges: [[pi, pi + q.length]] }
  // Tier 4 — fuzzy subsequence of the last token, with the original bonuses
  const last = tokens[tokens.length - 1] ?? ''
  let score = 0
  let qi = 0
  let prevMatch = -2
  const ranges: number[][] = []
  for (let c = 0; c < lower.length && qi < last.length; c++) {
    if (lower[c] === last[qi]) {
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
  if (qi < last.length) return { score: -1, ranges: [] }
  return { score, ranges }
}

/** render basename with matched chars (that fall inside it) bolded */
function highlight(base: string, ranges: number[][], baseOffset: number): JSX.Element[] {
  const inBase = new Set<number>()
  // a range can span many chars (a contiguous substring hit), not just one —
  // bold every index in [a, b), else a substring match highlights only its first char
  for (const [a, b] of ranges) for (let i = a; i < b; i++) if (i >= baseOffset) inBase.add(i - baseOffset)
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
