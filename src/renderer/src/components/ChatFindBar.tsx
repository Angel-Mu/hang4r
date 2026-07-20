import { useEffect, useState, type JSX, type RefObject } from 'react'
import { FindBar } from './FindBar'
import { claimFind, releaseFind } from '../findRegistry'

/**
 * Cmd+F "find in conversation" — a floating find bar over the focused tile's
 * chat transcript (round 12 ③). Matches are drawn with the CSS Custom
 * Highlight API (`CSS.highlights`) instead of wrapping matches in `<mark>`
 * elements: the transcript's DOM is owned and re-rendered by React while an
 * agent streams, so mutating it out-of-band (inserting <mark> nodes) risks
 * fighting React's reconciliation and crashing on the next re-render.
 * Highlight ranges live in a side registry and don't touch the DOM tree —
 * safe to recompute on every keystroke or transcript mutation.
 *
 * Known v1 gap: a match can't span two DOM text nodes (e.g. a search term
 * split across a **bold** boundary), and text inside a collapsed activity
 * group isn't found — it isn't in the DOM until expanded.
 */

// TypeScript's DOM lib types `CSS.highlights` (HighlightRegistry) with only
// `forEach` — the real runtime object is Map-like (set/delete/clear). Cast
// once here rather than sprinkling `as unknown as` through the file.
type HighlightMap = Map<string, Highlight>
function highlightRegistry(): HighlightMap | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return null
  return CSS.highlights as unknown as HighlightMap
}

const HL_ALL = 'chat-find'
const HL_CURRENT = 'chat-find-current'

function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  })
  const nodes: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) nodes.push(n as Text)
  return nodes
}

/** Case-insensitive substring search over the container's rendered text. */
function findRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase()
  if (!q) return []
  const ranges: Range[] = []
  for (const node of collectTextNodes(root)) {
    const text = node.textContent ?? ''
    const lower = text.toLowerCase()
    let from = 0
    for (;;) {
      const idx = lower.indexOf(q, from)
      if (idx === -1) break
      const r = new Range()
      r.setStart(node, idx)
      r.setEnd(node, idx + q.length)
      ranges.push(r)
      from = idx + q.length
    }
  }
  return ranges
}

export function ChatFindBar({
  containerRef,
  onClose,
  focusToken
}: {
  containerRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  focusToken: number
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)

  // recompute matches on query change, and lazily while the transcript
  // streams in (debounced MutationObserver — no need to re-search every delta)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const recompute = (): void => {
      const found = query.trim() ? findRanges(container, query.trim()) : []
      setRanges(found)
      setCurrent((i) => (found.length === 0 ? 0 : i % found.length))
    }
    recompute()
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(recompute, 250)
    })
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [containerRef, query])

  // paint highlights (all matches + the current one) without touching the DOM
  useEffect(() => {
    const registry = highlightRegistry()
    if (!registry) return
    if (ranges.length === 0) {
      registry.delete(HL_ALL)
      registry.delete(HL_CURRENT)
      return
    }
    registry.set(HL_ALL, new Highlight(...ranges))
    registry.set(HL_CURRENT, new Highlight(ranges[current] ?? ranges[0]))
    return () => {
      registry.delete(HL_ALL)
      registry.delete(HL_CURRENT)
    }
  }, [ranges, current])

  const goTo = (index: number): void => {
    if (ranges.length === 0) return
    const next = ((index % ranges.length) + ranges.length) % ranges.length
    setCurrent(next)
    ranges[next]?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }

  const close = (): void => {
    const registry = highlightRegistry()
    registry?.delete(HL_ALL)
    registry?.delete(HL_CURRENT)
    onClose()
  }

  // only one find bar app-wide (QA hunt #11): claim the slot on open, closing
  // whatever else was open; release it on close/unmount.
  useEffect(() => {
    const closeFn = (): void => close()
    claimFind(closeFn)
    return () => releaseFind(closeFn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <FindBar
      placeholder="Find in conversation"
      query={query}
      onQueryChange={setQuery}
      count={ranges.length}
      active={ranges.length === 0 ? 0 : current}
      onNext={() => goTo(current + 1)}
      onPrev={() => goTo(current - 1)}
      onClose={close}
      focusToken={focusToken}
    />
  )
}
