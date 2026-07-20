import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { buildCommands, type Command } from '../commands'
import { useHang4r } from '../state/store'

/** ⌘K command palette — fuzzy-search every action and jump to any session. */
export function CommandPalette(): JSX.Element | null {
  const open = useHang4r((s) => s.commandPaletteOpen)
  const close = useHang4r((s) => s.toggleCommandPalette)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commands = useMemo(() => (open ? buildCommands() : []), [open])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => fuzzy(c.title.toLowerCase(), q) || c.group.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => setActive(0), [query])

  if (!open) return null

  const run = (c: Command | undefined): void => {
    if (!c) return
    close(false)
    c.run()
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command or search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(filtered[active])
            } else if (e.key === 'Escape') {
              close(false)
            }
          }}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">No matching commands</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={'palette-item' + (i === active ? ' palette-item-active' : '')}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span className="palette-group">{c.group}</span>
              <span className="palette-title">{c.title}</span>
              {c.subtitle && <span className="palette-subtitle">{c.subtitle}</span>}
              {c.shortcut && <span className="palette-shortcut">{c.shortcut}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** subsequence fuzzy match */
function fuzzy(text: string, q: string): boolean {
  let i = 0
  for (const ch of text) {
    if (ch === q[i]) i++
    if (i === q.length) return true
  }
  return i === q.length
}
