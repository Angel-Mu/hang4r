import { useMemo, type JSX } from 'react'

export interface SlashItem {
  kind: 'command' | 'skill' | 'mode'
  name: string
  desc?: string
}

const KIND_LABEL: Record<SlashItem['kind'], string> = {
  command: 'Commands',
  skill: 'Skills',
  mode: 'Modes'
}

function subseq(text: string, q: string): boolean {
  let i = 0
  for (let c = 0; c < text.length && i < q.length; c++) if (text[c] === q[i]) i++
  return i === q.length
}

/** flat, filtered list shared with the parent so key-nav bounds match */
export function slashResults(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  const filtered = q ? items.filter((it) => subseq(it.name.toLowerCase(), q)) : items
  return filtered.slice(0, 40)
}

/**
 * `/`-command menu for the composer: built-in commands, session skills, and
 * modes (Cursor's slash menu, images 51/52). Rendered above the textarea while
 * the user types a `/token`; the parent drives keyboard nav.
 */
export function SlashMenu({
  items,
  query,
  active,
  onPick,
  onHover
}: {
  items: SlashItem[]
  query: string
  active: number
  onPick: (item: SlashItem) => void
  onHover: (i: number) => void
}): JSX.Element | null {
  const results = useMemo(() => slashResults(items, query), [items, query])
  if (results.length === 0) return null

  // group headers by kind, preserving order
  let lastKind: SlashItem['kind'] | null = null
  return (
    <div className="mention-menu slash-menu">
      {results.map((it, i) => {
        const header = it.kind !== lastKind ? KIND_LABEL[it.kind] : null
        lastKind = it.kind
        return (
          <div key={it.kind + it.name}>
            {header && <div className="slash-cat">{header}</div>}
            <button
              className={'mention-item slash-item' + (i === active ? ' mention-item-active' : '')}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(it)
              }}
            >
              <span className={'slash-glyph slash-glyph-' + it.kind}>
                {it.kind === 'skill' ? '◆' : it.kind === 'mode' ? '⊟' : '⚡'}
              </span>
              <span className="mention-name">/{it.name}</span>
              {it.desc && <span className="mention-dir">{it.desc}</span>}
            </button>
          </div>
        )
      })}
    </div>
  )
}
