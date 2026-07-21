import { useEffect, useState, type DragEvent, type HTMLAttributes, type JSX } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useHang4r } from '../state/store'
import { SessionTile } from './SessionTile'
import { ErrorBoundary } from './ErrorBoundary'

type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'

/**
 * Cursor-style tiled workspace: 1–4 resizable panes. Drag a tile header (or a
 * sidebar session) onto a pane's EDGE (left/right/top/bottom half) to split it
 * side-by-side on that side; drop on the center to move/swap; drop on the
 * workspace background to open as a new split. Layout persists across restarts.
 *
 *   1 pane   [A]
 *   2 panes  [A | B]
 *   3 panes  [A | B/C]
 *   4 panes  [A/C | B/D]
 */
export function Workspace(): JSX.Element {
  const openSessionIds = useHang4r((s) => s.openSessionIds)
  const expandedSessionId = useHang4r((s) => s.expandedSessionId)
  const dropSessionOnPane = useHang4r((s) => s.dropSessionOnPane)
  const [dropTarget, setDropTarget] = useState<{ index: number; zone: DropZone } | null>(null)

  // where in the pane's box is the cursor → which half to highlight/split.
  // Generous edge bands (30%) so halves are easy to hit; center = move/swap.
  const zoneFor = (e: DragEvent, el: HTMLElement): DropZone => {
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    if (x < 0.3) return 'left'
    if (x > 0.7) return 'right'
    if (y < 0.3) return 'top'
    if (y > 0.7) return 'bottom'
    return 'center'
  }

  const onDropPane = (e: DragEvent, paneIndex: number): void => {
    e.preventDefault()
    e.stopPropagation()
    const sessionId = e.dataTransfer.getData('application/x-hang4r-session')
    const zone = zoneFor(e, e.currentTarget as HTMLElement)
    if (sessionId) dropSessionOnPane(sessionId, paneIndex, zone)
    setDropTarget(null)
  }

  // a stray drop outside a pane (or an aborted drag) must clear the overlay
  useEffect(() => {
    const clear = (): void => setDropTarget(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  const paneProps = (i: number): HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      if (e.dataTransfer.types.includes('application/x-hang4r-session')) {
        e.preventDefault()
        setDropTarget({ index: i, zone: zoneFor(e, e.currentTarget) })
      }
    },
    onDragLeave: (e) => {
      // clear only when truly leaving this pane (not entering a child of it)
      if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node))
        setDropTarget((t) => (t?.index === i ? null : t))
    },
    onDrop: (e) => onDropPane(e, i)
  })

  const pane = (id: string, i: number): JSX.Element => (
    <div className="pane" {...paneProps(i)}>
      {/* per-tile boundary: a render error in ONE session shows a contained
          fallback instead of white-screening the whole app (Angel: an
          error_during_execution once forced a full app restart) */}
      {/* key by sessionId: without it, switching a pane to a DIFFERENT session
          reused this tile instance (React reconciles by position), so every
          child panel kept the previous session's useState — the Processes panel
          carried its `running` set across and started the new session's servers
          (Angel, CRITICAL). Keying forces a remount → fresh per-session state;
          the sessionId-keyed memos restore the intended persistent bits. */}
      <ErrorBoundary key={id} variant="tile" resetKey={id}>
        <SessionTile key={id} sessionId={id} />
      </ErrorBoundary>
      {dropTarget?.index === i && (
        <div className={'pane-drop-overlay pane-drop-' + dropTarget.zone} />
      )}
    </div>
  )

  if (openSessionIds.length === 0) {
    return (
      <main
        className="workspace workspace-bg"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDropPane(e, 99)}
      >
        <div className="workspace-empty">
          <h1>hang4r</h1>
          <p>Add a project, then start an agent session.</p>
          <p className="workspace-hint">
            Sessions run your local <code>claude</code> / <code>codex</code> CLIs — hooks, skills,
            MCP and your subscriptions included.
          </p>
        </div>
      </main>
    )
  }

  // expand-to-focus: one pane fills the workspace until toggled back
  if (expandedSessionId && openSessionIds.includes(expandedSessionId)) {
    return (
      <main className="workspace workspace-bg">
        {pane(expandedSessionId, openSessionIds.indexOf(expandedSessionId))}
      </main>
    )
  }

  const [a, b, c, d] = openSessionIds
  return (
    <main
      className="workspace workspace-bg"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-hang4r-session')) e.preventDefault()
      }}
      onDrop={(e) => onDropPane(e, 99)}
    >
      {openSessionIds.length === 1 && pane(a, 0)}

      {openSessionIds.length === 2 && (
        <Group orientation="horizontal" className="pane-group">
          <Panel minSize="20%">{pane(a, 0)}</Panel>
          <Separator className="resize-handle resize-handle-v" />
          <Panel minSize="20%">{pane(b, 1)}</Panel>
        </Group>
      )}

      {openSessionIds.length === 3 && (
        <Group orientation="horizontal" className="pane-group">
          <Panel minSize="20%">{pane(a, 0)}</Panel>
          <Separator className="resize-handle resize-handle-v" />
          <Panel minSize="20%">
            <Group orientation="vertical" className="pane-group">
              <Panel minSize="20%">{pane(b, 1)}</Panel>
              <Separator className="resize-handle resize-handle-h" />
              <Panel minSize="20%">{pane(c, 2)}</Panel>
            </Group>
          </Panel>
        </Group>
      )}

      {openSessionIds.length >= 4 && (
        <Group orientation="horizontal" className="pane-group">
          <Panel minSize="20%">
            <Group orientation="vertical" className="pane-group">
              <Panel minSize="20%">{pane(a, 0)}</Panel>
              <Separator className="resize-handle resize-handle-h" />
              <Panel minSize="20%">{pane(c, 2)}</Panel>
            </Group>
          </Panel>
          <Separator className="resize-handle resize-handle-v" />
          <Panel minSize="20%">
            <Group orientation="vertical" className="pane-group">
              <Panel minSize="20%">{pane(b, 1)}</Panel>
              <Separator className="resize-handle resize-handle-h" />
              <Panel minSize="20%">{pane(d, 3)}</Panel>
            </Group>
          </Panel>
        </Group>
      )}
    </main>
  )
}
