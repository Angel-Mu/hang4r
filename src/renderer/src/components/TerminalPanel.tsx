import { useEffect, useState, type JSX } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useHang4r } from '../state/store'
import { TerminalView } from './TerminalView'
import { Icon } from './Icon'
import { onForgetSession } from '../sessionUiMemos'

/** two terminals shown side by side (or stacked). Cap is 2 visible at once —
 *  matches the editor/workspace split model without the extra nesting a 3rd
 *  pane would need. `primary`/`secondary` are terminal ids; `active` (below)
 *  is always one of the two while a split is up. */
interface SplitState {
  orientation: 'side' | 'bottom'
  primary: string
  secondary: string
}

interface TerminalPanelState {
  terms: string[]
  active: string
  names: Record<string, string>
  nextN: number
  split: SplitState | null
}

/**
 * Terminal list/split arrangement per session, keyed by sessionId — the
 * Terminal tab unmounts when you switch to another context tab (SessionTile
 * renders only the active one), which would otherwise reset back to a single
 * fresh terminal. Mirrors FileBrowser's layoutMemo / CodeEditor's
 * viewStateMemo module-level-Map precedent. The PTYs themselves already
 * survive in the main process (with a scrollback ring buffer replayed on
 * re-attach), so restoring this arrangement just re-mounts the same ids.
 */
const stateMemo = new Map<string, TerminalPanelState>()
onForgetSession((sessionId) => stateMemo.delete(sessionId))

/**
 * Terminal-list width, as a percentage of the panel (the unit
 * react-resizable-panels sizes in — matches FileBrowser's files-tree split).
 * App-wide UI chrome (not per session), so a single module-level value — same
 * module-memo precedent as stateMemo above / FileBrowser's layoutMemo. Survives
 * leaving/returning to the Terminal tab (which unmounts the panel) and pane
 * remounts within a session. A hard 120px floor is enforced in CSS
 * (.terminal-list-panel min-width). Seeded into the Panel's defaultSize and
 * written back on every resize.
 */
let listWidthPctMemo = 24

function loadState(sessionId: string): TerminalPanelState {
  return (
    stateMemo.get(sessionId) ?? {
      terms: [`${sessionId}:t0`],
      active: `${sessionId}:t0`,
      names: {},
      nextN: 1,
      split: null
    }
  )
}

type DropZone = 'left' | 'right' | 'top' | 'bottom'

/**
 * Multiple terminals per session, with a terminal list (like iTerm/VS Code)
 * and a resizable split view (show two terminals side by side). Each terminal
 * is its own PTY in the main process, running in the session's working
 * directory.
 */
export function TerminalPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const [terms, setTerms] = useState<string[]>(() => loadState(sessionId).terms)
  const [active, setActive] = useState<string>(() => loadState(sessionId).active)
  const [split, setSplit] = useState<SplitState | null>(() => loadState(sessionId).split)
  const [nextN, setNextN] = useState<number>(() => loadState(sessionId).nextN)
  // custom terminal names (double-click a row to rename)
  const [names, setNames] = useState<Record<string, string>>(() => loadState(sessionId).names)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [dropZone, setDropZone] = useState<DropZone | null>(null)
  const nameFor = (id: string, i: number): string => names[id] ?? `shell ${i + 1}`

  // write-through so a later remount (leaving/returning to the Terminal tab)
  // restores this exact list + split arrangement.
  useEffect(() => {
    stateMemo.set(sessionId, { terms, active, names, nextN, split })
  }, [sessionId, terms, active, names, nextN, split])

  const addTerm = (): void => {
    const id = `${sessionId}:t${nextN}`
    setNextN((n) => n + 1)
    setTerms((t) => [...t, id])
    setActive(id)
  }

  // split the terminal currently active with a fresh one, side by side (⌘D),
  // or stacked (⌘⇧D) — same terminal the split-right/split-down button and
  // context menu actions use.
  const splitWithNew = (orientation: SplitState['orientation']): void => {
    const id = `${sessionId}:t${nextN}`
    setNextN((n) => n + 1)
    setTerms((t) => [...t, id])
    setSplit({ orientation, primary: active, secondary: id })
    setActive(id)
  }

  // slash workarounds (/remote-control, /doctor, …): open a fresh tab and run
  // the command once the SHELL is ready — not merely once the pty exists (a
  // write during shell init gets swallowed). The signal is consumed one-shot
  // up front so a later panel mount (⌃`) can never ghost-replay it.
  const commandToRun = useHang4r((s) => s.terminalCommandToRun)
  useEffect(() => {
    if (!commandToRun || commandToRun.sessionId !== sessionId) return
    const { command, label, nonce } = commandToRun
    useHang4r.getState().consumeTerminalCommand(nonce)
    const id = `${sessionId}:t${nextN}`
    setNextN((n) => n + 1)
    setTerms((t) => [...t, id])
    setActive(id)
    setNames((n) => ({ ...n, [id]: label }))
    // first pty output = the shell printed its prompt → safe to type
    let done = false
    const write = (): void => {
      if (done) return
      done = true
      off()
      setTimeout(() => void window.hang4r.writeTerminal(id, command + '\r'), 150)
    }
    const off = window.hang4r.onTerminalData((tid) => {
      if (tid === id) write()
    })
    // fallback: a silent shell (no prompt output) that IS live after ~9s
    let tries = 0
    const poll = (): void => {
      if (done) return
      void window.hang4r.processRunning(id).then((up) => {
        if (done) return
        if (up && tries >= 36) write()
        else if (++tries < 60) setTimeout(poll, 250)
        else off()
      })
    }
    setTimeout(poll, 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandToRun?.nonce])

  const closeTerm = (id: string): void => {
    void window.hang4r.disposeTerminal(id)
    // closing either half of a split collapses it back to the survivor
    const survivor =
      split && (id === split.primary || id === split.secondary)
        ? id === split.primary
          ? split.secondary
          : split.primary
        : null
    if (survivor) setSplit(null)
    setTerms((t) => {
      const next = t.filter((x) => x !== id)
      if (next.length === 0) {
        // always keep one terminal
        const fresh = `${sessionId}:t${nextN}`
        setNextN((n) => n + 1)
        setActive(fresh)
        return [fresh]
      }
      if (survivor) setActive(survivor)
      else setActive((a) => (a === id ? next[next.length - 1] : a))
      return next
    })
  }

  // Typing `exit` (or a crash) ends the PTY → close that terminal's tab/pane.
  useEffect(() => {
    return window.hang4r.onTerminalExit((id) => {
      if (id.startsWith(sessionId + ':')) closeTerm(id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // ⌘W closes the active terminal first (returns false on the last → tile closes).
  const isFocused = useHang4r((s) => s.focusedSessionId === sessionId)
  useEffect(() => {
    if (!isFocused) return
    useHang4r.getState().setScopedClose(() => {
      if (terms.length > 1) {
        closeTerm(active)
        return true
      }
      return false
    })
    return () => useHang4r.getState().setScopedClose(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, active, terms.length])

  // ⌘D new side pane · ⌘⇧D new bottom pane · ⌘[ / ⌘] move between panes/terminals
  // (iTerm), all when this terminal panel is focused
  useEffect(() => {
    if (!isFocused) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        splitWithNew(e.shiftKey ? 'bottom' : 'side')
        return
      }
      // ⌘[ prev · ⌘] next — meta only (⌃[ is ESC in the shell, never claim it).
      // When split, toggle the two halves; otherwise cycle the terminal list.
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === '[' || e.key === ']')) {
        const dir = e.key === ']' ? 1 : -1
        if (split) {
          e.preventDefault()
          setActive((a) => (a === split.primary ? split.secondary : split.primary))
        } else if (terms.length > 1) {
          e.preventDefault()
          setActive((a) => {
            const i = terms.indexOf(a)
            return i < 0 ? a : terms[(i + dir + terms.length) % terms.length]
          })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, active, nextN, split, terms])

  const rowMenu = (e: React.MouseEvent, id: string, i: number): void => {
    e.preventDefault()
    e.stopPropagation()
    useHang4r.getState().openContextMenu(e.clientX, e.clientY, [
      {
        label: 'Rename…',
        onClick: () => {
          setDraft(nameFor(id, i))
          setEditing(id)
        }
      },
      { label: 'Split right (⌘D)', onClick: () => splitWithNew('side') },
      { label: 'Split down (⌘⇧D)', onClick: () => splitWithNew('bottom') },
      { separator: true, label: '' },
      { label: 'Close', danger: true, onClick: () => closeTerm(id) }
    ])
  }

  // clicking a row: if it's already one of the two visible split halves, just
  // focus it; otherwise it takes over whichever half ISN'T currently focused
  // (the focused half stays put). Unsplit, it simply becomes the sole view.
  const onRowClick = (id: string): void => {
    if (split) {
      if (id === split.primary || id === split.secondary) {
        setActive(id)
        return
      }
      const replaceKey = active === split.primary ? 'secondary' : 'primary'
      setSplit({ ...split, [replaceKey]: id })
    }
    setActive(id)
  }

  // Cursor/iTerm2-style drag-to-split: drop a terminal list row onto an edge
  // of the visible terminal area to place it there side by side (left/right)
  // or stacked (top/bottom) with whatever's currently active.
  const zoneFor = (e: React.DragEvent, el: HTMLElement): DropZone => {
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    if (x < 0.3) return 'left'
    if (x > 0.7) return 'right'
    if (y < 0.3) return 'top'
    return 'bottom'
  }

  useEffect(() => {
    const clear = (): void => setDropZone(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  const renderSlot = (id: string, visible: boolean): JSX.Element => (
    <div key={id} className="terminal-slot" style={{ display: visible ? 'flex' : 'none' }}>
      <TerminalView sessionId={sessionId} id={id} active={id === active} />
    </div>
  )

  const visibleIds = split ? [split.primary, split.secondary] : [active]
  const hiddenIds = terms.filter((id) => !visibleIds.includes(id))

  return (
    <div className="terminal-panel">
      <Group orientation="horizontal" className="terminal-panel-group">
        <Panel
          minSize="8%"
          defaultSize={`${listWidthPctMemo}%`}
          className="terminal-list-panel"
          onResize={(s) => {
            listWidthPctMemo = s.asPercentage
          }}
        >
          <div className="terminal-list">
        <div className="terminal-list-head">
          <span>{terms.length} Terminal{terms.length > 1 ? 's' : ''}</span>
          <div className="terminal-list-actions">
            <button className="ghost-btn" title="New terminal" onClick={addTerm}>
              +
            </button>
            <button
              className="ghost-btn"
              title="Split terminal right (⌘D)"
              onClick={() => splitWithNew('side')}
            >
              <Icon name="split-h" size={13} />
            </button>
            <button
              className="ghost-btn"
              title="Split terminal down (⌘⇧D)"
              onClick={() => splitWithNew('bottom')}
            >
              <Icon name="split-v" size={13} />
            </button>
          </div>
        </div>
        {terms.map((id, i) => (
          <div
            key={id}
            className={'terminal-list-row' + (id === active ? ' terminal-list-row-active' : '')}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-hang4r-terminal', id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={() => onRowClick(id)}
            onContextMenu={(e) => rowMenu(e, id, i)}
          >
            <span className="terminal-list-icon">›_</span>
            {editing === id ? (
              <input
                className="terminal-list-rename"
                autoFocus
                value={draft}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  setNames((n) => ({ ...n, [id]: draft.trim() || `shell ${i + 1}` }))
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <span
                className="terminal-list-name"
                title="Double-click to rename"
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setDraft(names[id] ?? `shell ${i + 1}`)
                  setEditing(id)
                }}
              >
                {names[id] ?? `shell ${i + 1}`}
              </span>
            )}
            <button
              className="ghost-btn terminal-list-x"
              onClick={(e) => {
                e.stopPropagation()
                closeTerm(id)
              }}
            >
              ×
            </button>
          </div>
        ))}
          </div>
        </Panel>
        <Separator className="resize-handle resize-handle-v" />
        <Panel className="terminal-stack-panel">
      <div
        className={
          'terminal-stack' +
          (split
            ? ' terminal-stack-split' + (split.orientation === 'bottom' ? ' terminal-stack-split-bottom' : '')
            : '')
        }
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-hang4r-terminal')) return
          e.preventDefault()
          setDropZone(zoneFor(e, e.currentTarget))
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node))
            setDropZone(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          const draggedId = e.dataTransfer.getData('application/x-hang4r-terminal')
          const zone = dropZone ?? zoneFor(e, e.currentTarget)
          setDropZone(null)
          if (!draggedId || !terms.includes(draggedId)) return
          const orientation: SplitState['orientation'] = zone === 'top' || zone === 'bottom' ? 'bottom' : 'side'
          const nearEdge = zone === 'left' || zone === 'top'
          // Dragging the terminal you're LOOKING AT (always the active one —
          // and the only row when a session has a single terminal, the common
          // case) used to bail here (draggedId === active → no-op), so the most
          // natural "grab the terminal, pull it to the edge" gesture did
          // nothing. Split it against a FRESH terminal instead, placed on the
          // dropped edge — same result as the split button, honoring position.
          if (draggedId === active) {
            const id = `${sessionId}:t${nextN}`
            setNextN((n) => n + 1)
            setTerms((t) => [...t, id])
            const [primary, secondary] = nearEdge ? [id, active] : [active, id]
            setSplit({ orientation, primary, secondary })
            setActive(id)
            return
          }
          const [primary, secondary] = nearEdge ? [draggedId, active] : [active, draggedId]
          setSplit({ orientation, primary, secondary })
          setActive(draggedId)
        }}
      >
        {split ? (
          <Group
            orientation={split.orientation === 'bottom' ? 'vertical' : 'horizontal'}
            className="terminal-split-group"
          >
            <Panel minSize="20%" className="terminal-split-panel">
              {renderSlot(split.primary, true)}
            </Panel>
            <Separator
              className={
                'resize-handle ' + (split.orientation === 'bottom' ? 'resize-handle-h' : 'resize-handle-v')
              }
            />
            <Panel minSize="20%" className="terminal-split-panel">
              {renderSlot(split.secondary, true)}
            </Panel>
          </Group>
        ) : (
          renderSlot(active, true)
        )}
        {/* kept mounted (hidden) so scrollback survives switching, on top of
            the main-process ring buffer that replays it on re-attach anyway */}
        {hiddenIds.map((id) => renderSlot(id, false))}
        {dropZone && <div className={'pane-drop-overlay pane-drop-' + dropZone} />}
      </div>
        </Panel>
      </Group>
    </div>
  )
}
