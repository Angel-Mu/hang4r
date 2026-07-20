import { useEffect, useMemo, useState, type JSX } from 'react'

/** subsequence fuzzy match */
function subseq(text: string, q: string): boolean {
  let i = 0
  for (let c = 0; c < text.length && i < q.length; c++) if (text[c] === q[i]) i++
  return i === q.length
}

/**
 * Inline @-mention file picker for the composer. Rendered while the user is
 * typing an `@token`; the parent drives keyboard nav via `active` and calls
 * `onPick` when a file is chosen (Cursor's @-mention flow, image 36).
 */
export function MentionMenu({
  files,
  query,
  active,
  onPick,
  onHover
}: {
  files: string[]
  query: string
  active: number
  onPick: (path: string) => void
  onHover: (i: number) => void
}): JSX.Element | null {
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = !q ? files : files.filter((f) => subseq(f.toLowerCase(), q))
    return list.slice(0, 12)
  }, [files, query])

  if (results.length === 0) return null

  return (
    <div className="mention-menu">
      {results.map((path, i) => (
        <button
          key={path}
          className={'mention-item' + (i === active ? ' mention-item-active' : '')}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault() // keep textarea focus
            onPick(path)
          }}
        >
          <span className="mention-name">{path.split('/').pop()}</span>
          <span className="mention-dir">{path.slice(0, path.lastIndexOf('/'))}</span>
        </button>
      ))}
    </div>
  )
}

/** results resolver shared with the parent so key-nav bounds match the menu */
export function useMentionResults(files: string[], query: string): string[] {
  const [r, setR] = useState<string[]>([])
  useEffect(() => {
    const q = query.trim().toLowerCase()
    const list = !q ? files : files.filter((f) => subseq(f.toLowerCase(), q))
    setR(list.slice(0, 12))
  }, [files, query])
  return r
}
