import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useHang4r } from '../state/store'

/**
 * Composer + / @ attach menu: fuzzy-pick files from the session's workspace and
 * attach them as context chips (Cursor's @-mention / attach flow). Multi-select
 * — the menu stays open so you can add several, Esc/click-out to close.
 */
export function AttachMenu({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): JSX.Element {
  const addAttachment = useHang4r((s) => s.addAttachment)
  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.hang4r.listAllFiles(sessionId).then(setFiles)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [sessionId])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return files.slice(0, 40)
    return files.filter((f) => subseq(f.toLowerCase(), q)).slice(0, 40)
  }, [files, query])

  useEffect(() => setActive(0), [query])

  const attach = async (path?: string): Promise<void> => {
    if (!path) return
    const res = await window.hang4r.readFile(sessionId, path)
    addAttachment(sessionId, {
      label: path.split('/').pop() ?? path,
      text: `${path}\n${res.content.slice(0, 8000)}`
    })
    setAdded((s) => new Set(s).add(path))
  }

  return (
    <div className="attach-menu" ref={ref}>
      <input
        ref={inputRef}
        className="attach-input"
        placeholder="Attach a file… (⏎ add · Esc close)"
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
            void attach(results[active])
          } else if (e.key === 'Escape') {
            onClose()
          }
        }}
      />
      <div className="attach-list">
        {results.length === 0 && <div className="palette-empty">No files</div>}
        {results.map((path, i) => (
          <button
            key={path}
            className={'attach-item' + (i === active ? ' attach-item-active' : '')}
            onMouseEnter={() => setActive(i)}
            onClick={() => void attach(path)}
          >
            <span className="attach-check">{added.has(path) ? '✓' : '＋'}</span>
            <span className="attach-name">{path.split('/').pop()}</span>
            <span className="attach-dir">{path.slice(0, path.lastIndexOf('/'))}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function subseq(text: string, q: string): boolean {
  let i = 0
  for (let c = 0; c < text.length && i < q.length; c++) if (text[c] === q[i]) i++
  return i === q.length
}
