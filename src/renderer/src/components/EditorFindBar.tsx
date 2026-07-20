import { useEffect, useRef, useState, type JSX } from 'react'
import * as monaco from 'monaco-editor'
import { FindBar } from './FindBar'
import { claimFind, releaseFind } from '../findRegistry'

/**
 * The unified find bar (round 13 ①) scoped to a Monaco editor: our own bar over
 * the editor slot instead of Monaco's built-in find widget, driving Monaco's
 * search APIs so the look matches chat/terminal exactly. CodeEditor routes ⌘F
 * to us via an editor command (Monaco eats the key before window handlers, so
 * registering the command IS the routing) and mounts this while open.
 *
 * All matches get the `.hang4r-find-match` tint; the current one gets
 * `.hang4r-find-match-current` — the same accent-dim / accent pair the chat
 * highlights use.
 */
export function EditorFindBar({
  editor,
  focusToken,
  onClose
}: {
  editor: monaco.editor.IStandaloneCodeEditor
  focusToken: number
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<monaco.Range[]>([])
  const [current, setCurrent] = useState(0)
  const decos = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)

  // (re)compute matches when the query changes — and keep them fresh if the
  // document is edited while the bar is open.
  useEffect(() => {
    const recompute = (): void => {
      const model = editor.getModel()
      const q = query.trim()
      if (!model || !q) {
        setMatches([])
        return
      }
      const found = model.findMatches(q, false, false, false, null, false)
      const ranges = found.map((m) => m.range)
      setMatches(ranges)
      // land on the first match at/after the cursor, like VS Code
      const pos = editor.getPosition()
      let idx = 0
      if (pos) {
        // first match whose end is at/after the cursor (wraps to 0 if none)
        const at = ranges.findIndex((r) => !r.getEndPosition().isBefore(pos))
        idx = at === -1 ? 0 : at
      }
      setCurrent(idx)
    }
    recompute()
    const sub = editor.onDidChangeModelContent(() => recompute())
    return () => sub.dispose()
  }, [editor, query])

  // paint all-match + current-match decorations; reveal the current match
  useEffect(() => {
    if (!decos.current) decos.current = editor.createDecorationsCollection()
    if (matches.length === 0) {
      decos.current.clear()
      return
    }
    const all: monaco.editor.IModelDeltaDecoration[] = matches.map((range, i) => ({
      range,
      options: {
        inlineClassName: i === current ? 'hang4r-find-match-current' : 'hang4r-find-match',
        overviewRuler: {
          color: i === current ? 'var(--accent)' : 'var(--accent-dim)',
          position: monaco.editor.OverviewRulerLane.Center
        },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    }))
    decos.current.set(all)
    const cur = matches[current]
    if (cur) editor.revealRangeInCenter(cur, monaco.editor.ScrollType.Smooth)
  }, [editor, matches, current])

  // clear decorations on unmount (bar closed)
  useEffect(() => {
    return () => decos.current?.clear()
  }, [])

  // only one find bar app-wide (QA hunt #11): claim the slot on open, closing
  // whatever else was open; release it on close/unmount.
  useEffect(() => {
    const closeFn = (): void => onClose()
    claimFind(closeFn)
    return () => releaseFind(closeFn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const goTo = (index: number): void => {
    if (matches.length === 0) return
    setCurrent(((index % matches.length) + matches.length) % matches.length)
  }

  return (
    <FindBar
      placeholder="Find in file"
      query={query}
      onQueryChange={setQuery}
      count={matches.length}
      active={matches.length === 0 ? 0 : current}
      onNext={() => goTo(current + 1)}
      onPrev={() => goTo(current - 1)}
      onClose={onClose}
      focusToken={focusToken}
    />
  )
}
