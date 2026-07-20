import { useEffect, useState, type JSX } from 'react'
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'
import { FindBar } from './FindBar'
import { claimFind, releaseFind } from '../findRegistry'
import { cssToken } from '../theme'

/**
 * The unified find bar (round 13 ①) scoped to one terminal's scrollback,
 * driving @xterm/addon-search. The addon owns match highlighting + the
 * current-match decoration (xterm decorations take literal #RRGGBB colors, not
 * CSS vars — resolved from the active theme's tokens at call time).
 * `onDidChangeResults` feeds the n/N counter; it reports resultIndex -1 when
 * the match count blows past the addon's highlight threshold, which we
 * surface honestly (count shown, no active index).
 */
function opts(): ISearchOptions {
  const accent = cssToken('--accent', '#a48fe0')
  return {
    decorations: {
      matchBackground: '#4c4370',
      activeMatchBackground: accent,
      matchOverviewRuler: '#6c5f9e',
      activeMatchColorOverviewRuler: accent
    }
  }
}

export function TerminalFindBar({
  search,
  focusToken,
  onClose
}: {
  search: SearchAddon
  focusToken: number
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const sub = search.onDidChangeResults((e) => {
      setCount(e.resultCount)
      setActive(e.resultIndex < 0 ? 0 : e.resultIndex)
    })
    return () => sub.dispose()
  }, [search])

  // only one find bar app-wide (QA hunt #11): claim the slot on open, closing
  // whatever else was open; release it on close/unmount.
  useEffect(() => {
    const closeFn = (): void => onClose()
    claimFind(closeFn)
    return () => releaseFind(closeFn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // (re)run the search as the query changes; empty clears the highlights
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      search.clearDecorations()
      setCount(0)
      setActive(0)
      return
    }
    search.findNext(q, { ...opts(), incremental: true })
  }, [search, query])

  return (
    <FindBar
      placeholder="Find in terminal"
      query={query}
      onQueryChange={setQuery}
      count={count}
      active={active}
      onNext={() => query.trim() && search.findNext(query.trim(), opts())}
      onPrev={() => query.trim() && search.findPrevious(query.trim(), opts())}
      onClose={onClose}
      focusToken={focusToken}
    />
  )
}
