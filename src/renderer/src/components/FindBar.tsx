import { useEffect, useRef, type JSX, type RefObject } from 'react'

/**
 * The scope-agnostic find bar — the floating "find" chrome (input, n/N counter,
 * prev/next, close) that Angel approved for chat and wanted reused verbatim for
 * the code editor and terminals (round 13 ①). It owns NO search logic: each
 * scope drives it through a {@link FindProvider} and hands the bar the reactive
 * `count`/`active` to render.
 *
 * The class names stay `chat-find-*` so the shared stylesheet (and the chat
 * find e2e) keep working unchanged — despite the generic name, one look for all
 * three scopes is the whole point.
 */
export interface FindProvider {
  /** (re)compute matches for the current query */
  search: (query: string) => void
  /** move to the next match (wraps) */
  next: () => void
  /** move to the previous match (wraps) */
  prev: () => void
  /** total match count */
  count: number
  /** 0-based index of the current match (0 when none) */
  active: number
  /** tear down highlights/decorations/state when the bar closes */
  dispose: () => void
}

export function FindBar({
  placeholder,
  query,
  onQueryChange,
  count,
  active,
  onNext,
  onPrev,
  onClose,
  focusToken,
  inputRef
}: {
  placeholder: string
  query: string
  onQueryChange: (q: string) => void
  count: number
  active: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  /** bump to (re)focus + select the query — a repeat ⌘F while already open */
  focusToken: number
  inputRef?: RefObject<HTMLInputElement | null>
}): JSX.Element {
  const localRef = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? localRef

  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus()
      ref.current?.select()
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken])

  const has = count > 0
  return (
    <div className="chat-find-bar">
      <input
        ref={ref}
        className="chat-find-input"
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="chat-find-count">
        {query.trim() ? `${has ? active + 1 : 0}/${count}` : ''}
      </span>
      <button className="chat-find-nav" title="Previous match (⇧⏎)" disabled={!has} onClick={onPrev}>
        ‹
      </button>
      <button className="chat-find-nav" title="Next match (⏎)" disabled={!has} onClick={onNext}>
        ›
      </button>
      <button className="chat-find-close" title="Close (Esc)" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}
