import { useEffect, useRef, type JSX } from 'react'
import { searchEmoji } from '../../../shared/emoji'

export interface EmojiItem {
  shortcode: string
  emoji: string
}

/** flat, filtered list shared with the parent so key-nav bounds match */
export function emojiResults(query: string): EmojiItem[] {
  return searchEmoji(query, 24)
}

/**
 * `:`-shortcode typeahead for the composer, the WhatsApp/Slack behaviour: type
 * `:see` and pick 🙈. Laid out as a horizontal strip rather than the `/` menu's
 * vertical list — the glyph IS the label, so a row of them is faster to scan
 * than 24 stacked names. The parent drives keyboard nav.
 */
export function EmojiMenu({
  items,
  active,
  onPick,
  onHover
}: {
  items: EmojiItem[]
  active: number
  onPick: (item: EmojiItem) => void
  onHover: (i: number) => void
}): JSX.Element | null {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  if (items.length === 0) return null

  return (
    <div className="mention-menu emoji-menu">
      {items.map((it, i) => (
        <button
          key={it.shortcode}
          ref={i === active ? activeRef : undefined}
          className={'emoji-item' + (i === active ? ' emoji-item-active' : '')}
          title={`:${it.shortcode}:`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(it)
          }}
        >
          {it.emoji}
        </button>
      ))}
      <span className="emoji-menu-hint">:{items[active]?.shortcode ?? ''}:</span>
    </div>
  )
}
