import { useCallback, useEffect, useRef, useState, Fragment, type JSX, type DragEvent as ReactDragEvent } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { DirEntry } from '../../../shared/protocol'
import { useHang4r } from '../state/store'
import { onForgetSession, onSeedSessionUi, persistSessionUi } from '../sessionUiMemos'
import { fileIcon, type FileIcon } from '../fileIcons'
import { Icon } from './Icon'
import { SearchPanel } from './SearchPanel'
import { CodeEditor, type EditorHandle } from './CodeEditor'
import { MediaViewer, mediaKind } from './MediaViewer'

/** one editor group in the viewer: its own tab list + active tab. `id` is a
 *  stable identity (NOT an array index) so React never remounts a group's
 *  editors when siblings appear/disappear or the layout reshapes — a remount
 *  reloads from disk and killed unsaved edits (QA round 4 P1). */
type EditorGroup = { id: number; openFiles: string[]; active: string | null }

/** An unsaved buffer with no disk path yet is tracked in `openFiles` as the
 *  pseudo-path `untitled:N` (N monotonic, so React keys never collide) and shown
 *  as `Untitled-N`. ⌘N in the Files panel makes one; ⌘S names + writes it. */
const isUntitledPath = (p: string): boolean => p.startsWith('untitled:')
const tabDisplayName = (p: string): string =>
  isUntitledPath(p) ? 'Untitled-' + p.slice('untitled:'.length) : (p.split('/').pop() ?? p)
let untitledSeq = 0

/** the editor area is a TREE of splits (VS Code's nested split model): a leaf
 *  holds one EditorGroup; a split arranges children horizontally ('h', side by
 *  side) or vertically ('v', stacked). Any leaf can itself be split, so e.g.
 *  two columns where the right column is two stacked editors = an 'h' split
 *  whose second child is a 'v' split. */
type LeafNode = { kind: 'leaf'; group: EditorGroup }
type SplitNode = { kind: 'split'; dir: 'h' | 'v'; children: LayoutNode[]; id: number }
type LayoutNode = LeafNode | SplitNode

/** sane upper bound on simultaneous editors (edge drops past this open in place) */
const MAX_LEAVES = 6

/**
 * Open tabs / active file / split structure per session, keyed by sessionId —
 * a workspace re-split remounts the whole FileBrowser (new pane-tree shape in
 * Workspace.tsx), which would otherwise reset local `layout` state to empty.
 * Mirrors CodeEditor's viewStateMemo/sharedDirty module-level-Map precedent.
 */
const layoutMemo = new Map<string, LayoutNode>()
/** which leaf was focused (target for tree-clicks/⌘P) — same rationale */
const focusedGroupIdMemo = new Map<string, number>()

// archiving a session removes its worktree — its remembered layout is dead
onForgetSession((sessionId) => {
  layoutMemo.delete(sessionId)
  focusedGroupIdMemo.delete(sessionId)
})

// seed the layout from the persisted snapshot (before the tile mounts) so open
// files survive an app restart / reload. Only fill an EMPTY memo — never clobber
// live in-memory state (a session that's already open has the authoritative copy).
onSeedSessionUi((sessionId, snap) => {
  if (snap.layout && !layoutMemo.has(sessionId)) layoutMemo.set(sessionId, snap.layout as LayoutNode)
})

function emptyLayout(): LayoutNode {
  return { kind: 'leaf', group: { id: 0, openFiles: [], active: null } }
}

/** every EditorGroup in the tree, in left-to-right / top-to-bottom order */
function leaves(node: LayoutNode): EditorGroup[] {
  return node.kind === 'leaf' ? [node.group] : node.children.flatMap(leaves)
}
/** highest group/split id anywhere in the tree — restoring layout from
 *  layoutMemo must seed the id counters past these so newly created groups/
 *  splits never collide with the restored ones. */
function maxGroupId(node: LayoutNode): number {
  return node.kind === 'leaf' ? node.group.id : Math.max(...node.children.map(maxGroupId))
}
function maxSplitId(node: LayoutNode): number {
  return node.kind === 'leaf' ? -1 : Math.max(node.id, ...node.children.map(maxSplitId))
}
function findGroup(node: LayoutNode, id: number): EditorGroup | undefined {
  return leaves(node).find((g) => g.id === id)
}
/** rebuild the tree, replacing every group via `fn`. Node identities change but
 *  render keys (group/split id) are stable, so no leaf remounts. */
function mapGroups(node: LayoutNode, fn: (g: EditorGroup) => EditorGroup): LayoutNode {
  return node.kind === 'leaf'
    ? { kind: 'leaf', group: fn(node.group) }
    : { ...node, children: node.children.map((c) => mapGroups(c, fn)) }
}
/** remove the leaf whose group id matches; a split left with one child collapses
 *  into that child (recursively). Returns null if the whole tree emptied. */
function removeLeaf(node: LayoutNode, id: number): LayoutNode | null {
  if (node.kind === 'leaf') return node.group.id === id ? null : node
  const kids = node.children
    .map((c) => removeLeaf(c, id))
    .filter((c): c is LayoutNode => c !== null)
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
  return { ...node, children: kids }
}
/** split the target leaf: insert a new leaf beside it in direction `dir`
 *  (`before` = left/top). When the target already sits in a same-direction split
 *  we flatten (insert a sibling — no remount at all); otherwise the target leaf
 *  is wrapped in a fresh split node (only that leaf remounts; its unsaved content
 *  survives via CodeEditor's shared-dirty registry). */
function splitLeaf(
  node: LayoutNode,
  targetId: number,
  dir: 'h' | 'v',
  fresh: EditorGroup,
  before: boolean,
  nextSplitId: () => number
): LayoutNode {
  const newLeaf: LeafNode = { kind: 'leaf', group: fresh }
  const wrap = (leaf: LayoutNode): SplitNode => ({
    kind: 'split',
    dir,
    id: nextSplitId(),
    children: before ? [newLeaf, leaf] : [leaf, newLeaf]
  })
  if (node.kind === 'leaf') return node.group.id === targetId ? wrap(node) : node
  const idx = node.children.findIndex((c) => c.kind === 'leaf' && c.group.id === targetId)
  if (idx >= 0) {
    if (node.dir === dir) {
      const kids = [...node.children]
      kids.splice(before ? idx : idx + 1, 0, newLeaf)
      return { ...node, children: kids }
    }
    return { ...node, children: node.children.map((c, i) => (i === idx ? wrap(c) : c)) }
  }
  return {
    ...node,
    children: node.children.map((c) => splitLeaf(c, targetId, dir, fresh, before, nextSplitId))
  }
}

/** render a file-type icon: an SVG when named, else a monochrome text badge */
function FileGlyph({ fi }: { fi: FileIcon }): JSX.Element {
  return (
    <span className="file-icon" style={{ color: fi.color }}>
      {fi.icon ? <Icon name={fi.icon} size={13} /> : fi.glyph}
    </span>
  )
}

/**
 * Project file browser scoped to a session's working directory.
 * Lazy tree on the left; an editor with a TAB BAR on the right — open multiple
 * files at once (click a tree file to open/focus its tab; × closes it).
 * Editable Monaco (⌘S save; right-click "Add selection to chat").
 */
export function FileBrowser({ sessionId }: { sessionId: string }): JSX.Element {
  const addAttachment = useHang4r((s) => s.addAttachment)
  // Editor area = a TREE of splits (VS Code's nested model). A leaf holds one
  // EditorGroup; splits nest arbitrarily up to MAX_LEAVES. Root starts as a
  // single leaf, which renders identically to the old single-viewer behavior.
  const [layout, setLayout] = useState<LayoutNode>(() => layoutMemo.get(sessionId) ?? emptyLayout())
  // seed past any ids already used in a restored tree so new groups/splits
  // never collide with ones the memoized layout brought back
  const nextGroupId = useRef(maxGroupId(layout) + 1)
  const nextSplitId = useRef(maxSplitId(layout) + 1)
  const [focusedGroupId, setFocusedGroupId] = useState<number>(() => {
    const saved = focusedGroupIdMemo.get(sessionId)
    return saved !== undefined && leaves(layout).some((g) => g.id === saved) ? saved : leaves(layout)[0].id
  })
  const isSplit = leaves(layout).length > 1
  // refs mirror the latest values so stable callbacks (openFile, closeFile,
  // scopedClose, split) don't go stale and don't need to be re-created on change.
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const focusedGroupIdRef = useRef(focusedGroupId)
  const focusGroup = useCallback(
    (id: number): void => {
      focusedGroupIdRef.current = id
      focusedGroupIdMemo.set(sessionId, id)
      setFocusedGroupId(id)
    },
    [sessionId]
  )
  // commit a new tree to both the ref (for stable callbacks) and React state,
  // write-through to layoutMemo so a later remount restores this exact tree.
  const commit = useCallback(
    (next: LayoutNode): void => {
      layoutRef.current = next
      layoutMemo.set(sessionId, next)
      setLayout(next)
      // persist so open files survive an app restart (not just a remount)
      void persistSessionUi(sessionId, { layout: next })
    },
    [sessionId]
  )
  // rebuild the tree with each group transformed by `fn`.
  const updateGroups = useCallback(
    (fn: (g: EditorGroup) => EditorGroup): void => {
      commit(mapGroups(layoutRef.current, fn))
    },
    [commit]
  )
  // multi-select (cmd/shift-click) for batch add-to-chat / delete
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClicked = useRef<string | null>(null)
  const onFileClick = useCallback(
    (ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, path: string, siblings: string[]): void => {
      if (ev.metaKey || ev.ctrlKey) {
        setSelected((s) => {
          const n = new Set(s)
          n.has(path) ? n.delete(path) : n.add(path)
          return n
        })
        lastClicked.current = path
        return
      }
      if (ev.shiftKey && lastClicked.current && siblings.includes(lastClicked.current)) {
        const a = siblings.indexOf(lastClicked.current)
        const b = siblings.indexOf(path)
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected(new Set(siblings.slice(lo, hi + 1)))
        return
      }
      setSelected(new Set())
      lastClicked.current = path
      openFile(path)
    },
    // openFile defined below; referenced via closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  /** open paths with unsaved changes (tab dirty-dot) */
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set())
  const onDirtyChange = useCallback((path: string, dirty: boolean): void => {
    setDirtyPaths((s) => {
      if (s.has(path) === dirty) return s
      const n = new Set(s)
      dirty ? n.add(path) : n.delete(path)
      return n
    })
  }, [])
  // live save handles keyed by `${group.id}:${path}` (stable id, not index —
  // indices shift when a group is inserted before another). Keying by group
  // matters when the same file is open in both groups: closing it in one group
  // must NOT drop the other group's handle.
  const handles = useRef<Map<string, EditorHandle>>(new Map())

  const registerHandle = useCallback((gi: number, path: string, h: EditorHandle | null): void => {
    const key = `${gi}:${path}`
    if (h) handles.current.set(key, h)
    else handles.current.delete(key)
  }, [])

  // open a path into a specific leaf, focusing it (used by the focused-open path
  // and by center-zone drops).
  const openInto = useCallback(
    (id: number, path: string): void => {
      focusGroup(id)
      updateGroups((g) =>
        g.id === id
          ? {
              ...g,
              openFiles: g.openFiles.includes(path) ? g.openFiles : [...g.openFiles, path],
              active: path
            }
          : g
      )
    },
    [focusGroup, updateGroups]
  )

  // open a file into the FOCUSED leaf (tree click, ⌘P, go-to-definition all
  // target the leaf the user last interacted with).
  const openFile = useCallback(
    (path: string): void => {
      openInto(focusedGroupIdRef.current, path)
    },
    [openInto]
  )

  const setGroupActive = useCallback(
    (id: number, path: string): void => {
      focusGroup(id)
      updateGroups((g) => (g.id === id ? { ...g, active: path } : g))
    },
    [focusGroup, updateGroups]
  )

  // ⌘N (Files panel): open a fresh untitled buffer in the focused leaf — no disk
  // file yet; ⌘S in the editor names + writes it (VS Code untitled UX).
  const newUntitledFile = useCallback((): void => {
    openInto(focusedGroupIdRef.current, `untitled:${++untitledSeq}`)
  }, [openInto])

  // ⌘P requested a file for this session → open it here
  const fileToOpen = useHang4r((s) => s.fileToOpen)
  useEffect(() => {
    if (fileToOpen && fileToOpen.sessionId === sessionId) openFile(fileToOpen.path)
  }, [fileToOpen, sessionId, openFile])

  const isFocused = useHang4r((s) => s.focusedSessionId === sessionId)

  // remove a leaf by group id, collapsing single-child splits back up the tree.
  // When the last leaf goes, reset to one empty leaf (never an empty tree).
  const removeGroup = useCallback(
    (id: number): void => {
      const next = removeLeaf(layoutRef.current, id)
      if (!next) {
        const fresh: LeafNode = {
          kind: 'leaf',
          group: { id: nextGroupId.current++, openFiles: [], active: null }
        }
        commit(fresh)
        focusGroup(fresh.group.id)
        return
      }
      commit(next)
      // refocus the first surviving leaf if the focused one is gone
      const survivors = leaves(next)
      if (!survivors.some((g) => g.id === focusedGroupIdRef.current)) {
        focusGroup(survivors[0].id)
      }
    },
    [commit, focusGroup]
  )

  const doClose = useCallback(
    (id: number, path: string): void => {
      const g = findGroup(layoutRef.current, id)
      if (!g) return
      const nextFiles = g.openFiles.filter((p) => p !== path)
      // closing the last tab of a leaf removes the leaf (and collapses the split)
      // — but never the final leaf, which just goes empty.
      if (nextFiles.length === 0 && leaves(layoutRef.current).length > 1) {
        removeGroup(id)
        return
      }
      const nextActive = g.active === path ? (nextFiles[nextFiles.length - 1] ?? null) : g.active
      updateGroups((x) => (x.id === id ? { ...x, openFiles: nextFiles, active: nextActive } : x))
    },
    [removeGroup, updateGroups]
  )

  // Cursor-style save prompt on unsaved changes — never silently save/lose.
  // Returns false if the user cancelled (abort the close). When the same file
  // stays open in ANOTHER leaf, closing this view never prompts and never
  // discards — the shared doc (and its unsaved edits) lives on over there.
  const maybeFlush = useCallback(async (id: number, path: string): Promise<boolean> => {
    const ls = leaves(layoutRef.current)
    const openElsewhere = ls.some((g) => g.id !== id && g.openFiles.includes(path))
    if (openElsewhere) return true
    const h = handles.current.get(`${id}:${path}`)
    if (h?.isDirty()) {
      const choice = await useHang4r
        .getState()
        .showSave(
          `Do you want to save the changes you made to ${path.split('/').pop()}?`,
          "Your changes will be lost if you don't save them."
        )
      if (choice === 'cancel') return false
      if (choice === 'save') await h.save()
      else h.discard() // "Don't Save": mark the shared doc clean → next open reloads disk
    }
    return true
  }, [])

  const closeFile = useCallback(
    async (id: number, path: string): Promise<void> => {
      if (!(await maybeFlush(id, path))) return
      doClose(id, path)
    },
    [maybeFlush, doClose]
  )

  // close every tab in a leaf (its ✕), flushing unsaved edits, then collapse it.
  const closeGroup = useCallback(
    async (id: number): Promise<void> => {
      const g = findGroup(layoutRef.current, id)
      if (!g) return
      for (const p of [...g.openFiles]) {
        if (!(await maybeFlush(id, p))) return
      }
      removeGroup(id)
    },
    [maybeFlush, removeGroup]
  )

  // split the focused leaf's active file into a new leaf beside it (nesting).
  const doSplit = useCallback(
    (dir: 'h' | 'v'): void => {
      const id = focusedGroupIdRef.current
      const active = findGroup(layoutRef.current, id)?.active
      if (!active) return
      if (leaves(layoutRef.current).length >= MAX_LEAVES) return
      const fresh: EditorGroup = { id: nextGroupId.current++, openFiles: [active], active }
      commit(splitLeaf(layoutRef.current, id, dir, fresh, false, () => nextSplitId.current++))
      focusGroup(fresh.id)
    },
    [commit, focusGroup]
  )

  // ---- drag a file from the tree onto a LEAF (VS Code semantics), computed
  // against that leaf's box: center = open in it · left/right edge = split it
  // side-by-side · top/bottom edge = split it stacked. Nesting is unbounded up
  // to MAX_LEAVES; an edge drop at the cap just opens into the hovered leaf.
  type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'
  const [dropTarget, setDropTarget] = useState<{ id: number; zone: DropZone } | null>(null)
  const leafRefs = useRef<Map<number, HTMLDivElement | null>>(new Map())

  const zoneForLeaf = (id: number, clientX: number, clientY: number): DropZone => {
    const r = leafRefs.current.get(id)?.getBoundingClientRect()
    if (!r) return 'center'
    const x = (clientX - r.left) / r.width
    const y = (clientY - r.top) / r.height
    if (x < 0.2) return 'left'
    if (x > 0.8) return 'right'
    if (y < 0.2) return 'top'
    if (y > 0.8) return 'bottom'
    return 'center'
  }

  const dropOnLeaf = useCallback(
    (id: number, path: string, zone: DropZone): void => {
      // center, or no room left to nest → open into the hovered leaf
      if (zone === 'center' || leaves(layoutRef.current).length >= MAX_LEAVES) {
        openInto(id, path)
        return
      }
      const dir: 'h' | 'v' = zone === 'left' || zone === 'right' ? 'h' : 'v'
      const before = zone === 'left' || zone === 'top'
      const fresh: EditorGroup = { id: nextGroupId.current++, openFiles: [path], active: path }
      commit(splitLeaf(layoutRef.current, id, dir, fresh, before, () => nextSplitId.current++))
      focusGroup(fresh.id)
    },
    [openInto, commit, focusGroup]
  )

  // per-leaf drag handlers — each leaf's container carries its own drop zone
  const leafDndProps = (
    id: number
  ): {
    onDragOver: (ev: ReactDragEvent) => void
    onDragLeave: (ev: ReactDragEvent) => void
    onDrop: (ev: ReactDragEvent) => void
  } => ({
    onDragOver: (ev: ReactDragEvent): void => {
      if (!ev.dataTransfer.types.includes('application/x-hang4r-file')) return
      ev.preventDefault()
      ev.stopPropagation()
      ev.dataTransfer.dropEffect = 'copy'
      setDropTarget({ id, zone: zoneForLeaf(id, ev.clientX, ev.clientY) })
    },
    onDragLeave: (ev: ReactDragEvent): void => {
      // clear only when truly leaving this leaf (not entering a child of it)
      if (ev.currentTarget === ev.target || !ev.currentTarget.contains(ev.relatedTarget as Node))
        setDropTarget((d) => (d?.id === id ? null : d))
    },
    onDrop: (ev: ReactDragEvent): void => {
      const path = ev.dataTransfer.getData('application/x-hang4r-file')
      const zone = zoneForLeaf(id, ev.clientX, ev.clientY)
      setDropTarget(null)
      if (!path) return
      ev.preventDefault()
      ev.stopPropagation()
      dropOnLeaf(id, path, zone)
    }
  })

  useEffect(() => {
    const clear = (): void => setDropTarget(null)
    window.addEventListener('dragend', clear)
    return () => window.removeEventListener('dragend', clear)
  }, [])

  // ⌘W scoped close: close the focused leaf's active file
  useEffect(() => {
    if (!isFocused) return
    useHang4r.getState().setScopedClose(() => {
      const active = findGroup(layoutRef.current, focusedGroupIdRef.current)?.active
      if (active) {
        void closeFile(focusedGroupIdRef.current, active)
        return true
      }
      return false
    })
    return () => useHang4r.getState().setScopedClose(null)
  }, [isFocused, closeFile])

  // ⌘N scoped new-file: while the Files panel is the focused tile's live panel,
  // ⌘N opens an untitled buffer instead of the new-session dialog
  useEffect(() => {
    if (!isFocused) return
    useHang4r.getState().setScopedNewFile(() => {
      newUntitledFile()
      return true
    })
    return () => useHang4r.getState().setScopedNewFile(null)
  }, [isFocused, newUntitledFile])

  // ⌘\ splits the focused leaf to the right (only while this tile is focused)
  useEffect(() => {
    if (!isFocused) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        doSplit('h')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isFocused, doSplit])

  // bump to force the tree to re-fetch from disk (folder-expansion state below
  // is lifted here, so a refresh preserves which folders are open)
  const [treeKey, setTreeKey] = useState(0)
  const refreshTree = useCallback(() => setTreeKey((k) => k + 1), [])

  // an untitled tab was saved (⌘S/⌘⇧S) or a real file "saved as" → swap its tab
  // path from the pseudo-path (or old path) to the real one and refresh the tree.
  const rebindTab = useCallback(
    (id: number, oldPath: string, newPath: string): void => {
      updateGroups((g) => {
        if (g.id !== id) return g
        const openFiles = g.openFiles.includes(newPath)
          ? g.openFiles.filter((p) => p !== oldPath) // target already open here → drop the source
          : g.openFiles.map((p) => (p === oldPath ? newPath : p))
        return { ...g, openFiles, active: newPath }
      })
      refreshTree()
    },
    [updateGroups, refreshTree]
  )
  // which folders are expanded — owned here so Refresh keeps them open and
  // Collapse-all is a distinct action that clears them
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = useCallback((path: string): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const collapseAll = useCallback(() => setExpanded(new Set()), [])

  // git working-tree status for the explorer badges/actions
  const [git, setGit] = useState<Record<string, { badge: string; staged: boolean }>>({})
  const refreshGit = useCallback(() => {
    void window.hang4r.gitStatus(sessionId).then(setGit)
  }, [sessionId])
  const sessionStatus = useHang4r((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const gitNonce = useHang4r((s) => s.gitNonce)
  useEffect(() => {
    refreshGit()
  }, [refreshGit, treeKey, sessionStatus, gitNonce])

  // Cursor-style sidebar modes: the panel area swaps between the file tree
  // and the search-in-files view (⌘⇧F / the magnifier icon) — search is NOT
  // a separate pane, per Angel's explicit ask.
  const [mode, setMode] = useState<'tree' | 'search'>('tree')
  // the whole tree column can hide (slim rail remains) and is resizable
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const searchToOpen = useHang4r((s) => s.searchToOpen)
  useEffect(() => {
    if (searchToOpen && searchToOpen.sessionId === sessionId) {
      setMode('search')
      setTreeCollapsed(false)
    }
  }, [searchToOpen, sessionId])

  // explorer search: filename filter only. Content search-in-files lives in the
  // in-panel Search view (the canonical find/replace experience).
  const [query, setQuery] = useState('')
  const [allPaths, setAllPaths] = useState<string[]>([])
  useEffect(() => {
    if (query) void window.hang4r.listAllFiles(sessionId).then(setAllPaths)
  }, [query, sessionId])
  const fileMatches = query
    ? allPaths.filter((p) => p.toLowerCase().includes(query.toLowerCase())).slice(0, 200)
    : []

  const newFile = useCallback(async (): Promise<void> => {
    const name = await useHang4r.getState().showPrompt('New file (path relative to project root):')
    if (!name?.trim()) return
    await window.hang4r.createFile(sessionId, name.trim())
    refreshTree()
    openFile(name.trim())
  }, [sessionId, refreshTree, openFile])

  const newFolder = useCallback(async (): Promise<void> => {
    const name = await useHang4r.getState().showPrompt('New folder (path relative to project root):')
    if (!name?.trim()) return
    await window.hang4r.createDir(sessionId, name.trim())
    refreshTree()
  }, [sessionId, refreshTree])

  // one leaf: its tab row (split / close affordances) over a keep-mounted editor
  // stack, wrapped in a drop-aware container. Clicking anywhere focuses it, so
  // tree clicks and ⌘P open into whichever leaf the user last touched.
  const renderLeaf = (g: EditorGroup): JSX.Element => (
    <div
      className={'editor-group' + (isSplit && g.id === focusedGroupId ? ' editor-group-focused' : '')}
      onMouseDown={() => focusGroup(g.id)}
      ref={(el) => {
        leafRefs.current.set(g.id, el)
      }}
      {...leafDndProps(g.id)}
    >
      {dropTarget?.id === g.id && <div className={'drop-overlay drop-' + dropTarget.zone} />}
      {g.openFiles.length > 0 && (
        <div className="editor-tabs">
          {g.openFiles.map((path) => (
            <div
              key={path}
              className={
                'editor-tab' +
                (path === g.active ? ' editor-tab-active' : '') +
                (dirtyPaths.has(path) ? ' editor-tab-dirty' : '')
              }
              onClick={() => setGroupActive(g.id, path)}
              title={path}
            >
              <FileGlyph fi={fileIcon(path)} />
              <span className="editor-tab-name">{tabDisplayName(path)}</span>
              <button
                className="editor-tab-x"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeFile(g.id, path)
                }}
              >
                <span className="editor-tab-dot">●</span>
                <span className="editor-tab-close">×</span>
              </button>
            </div>
          ))}
          <div className="editor-tabs-actions">
            <button className="ghost-btn" title="Split right (⌘\)" onClick={() => doSplit('h')}>
              <Icon name="split-h" size={13} />
            </button>
            <button className="ghost-btn" title="Split down" onClick={() => doSplit('v')}>
              <Icon name="split-v" size={13} />
            </button>
            {isSplit && (
              <button
                className="ghost-btn"
                title="Close group"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeGroup(g.id)
                }}
              >
                <span className="editor-group-x">×</span>
              </button>
            )}
          </div>
        </div>
      )}
      <div className="editor-stack">
        {g.openFiles.length === 0 && <div className="diff-empty">Select a file to view or edit.</div>}
        {/* keep all open editors mounted (preserve cursor/scroll/undo); show active */}
        {g.openFiles.map((path) => {
          const kind = mediaKind(path)
          // markdown/html get their own Preview/Source toggle inside CodeEditor;
          // only image/pdf (no source view) swap to the read-only MediaViewer.
          const preview = kind === 'image' || kind === 'pdf'
          return (
            <div
              key={path}
              className="editor-slot"
              style={{ display: path === g.active ? 'flex' : 'none' }}
            >
              {preview ? (
                <MediaViewer sessionId={sessionId} path={path} kind={kind} />
              ) : (
                <CodeEditor
                  sessionId={sessionId}
                  path={path}
                  onAddToChat={(label, text) => addAttachment(sessionId, { label, text })}
                  onRegister={(p, h) => registerHandle(g.id, p, h)}
                  onDirtyChange={onDirtyChange}
                  onSavedAs={(oldP, newP) => rebindTab(g.id, oldP, newP)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  // the tree column: toolbar (tree toggle left, everything else right — no
  // title text, per Angel) over the tree or search view
  const treeColumn = (
    <div className="files-tree">
        <div className="files-tree-toolbar">
          <button
            className={'ghost-btn' + (mode === 'tree' ? ' files-mode-on' : '')}
            title={mode === 'tree' ? 'Hide file tree' : 'Show file tree'}
            onClick={() => (mode === 'tree' ? setTreeCollapsed(true) : setMode('tree'))}
          >
            <Icon name="files" size={14} />
          </button>
          <div className="files-tree-actions">
            <button
              className={'ghost-btn files-search-mode' + (mode === 'search' ? ' files-mode-on' : '')}
              title="Search in files (⌘⇧F)"
              onClick={() => setMode('search')}
            >
              <Icon name="search" size={13} />
            </button>
            {mode === 'tree' && (
              <>
              <button className="ghost-btn" title="New file" onClick={() => void newFile()}>
                <Icon name="file-plus" size={14} />
              </button>
              <button className="ghost-btn" title="New folder" onClick={() => void newFolder()}>
                <Icon name="folder-plus" size={14} />
              </button>
              <button className="ghost-btn" title="Refresh" onClick={refreshTree}>
                <Icon name="refresh" size={13} />
              </button>
              <button className="ghost-btn" title="Collapse all" onClick={collapseAll}>
                <Icon name="collapse-all" size={13} />
              </button>
              </>
            )}
          </div>
        </div>
        {mode === 'search' ? (
          <SearchPanel sessionId={sessionId} onClose={() => setMode('tree')} />
        ) : (
          <>
        <div className="files-search">
          <input
            className="files-search-input"
            placeholder="Filter files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {query.trim() ? (
          <div className="search-results">
            {fileMatches.length === 0 && <div className="search-empty">No files</div>}
            {fileMatches.map((p) => (
              <button key={p} className="file-row" onClick={() => openFile(p)}>
                <FileGlyph fi={fileIcon(p)} />
                <span className="file-name">{p.split('/').pop()}</span>
                <span className="search-file-dir">{p.slice(0, p.lastIndexOf('/'))}</span>
              </button>
            ))}
          </div>
        ) : (
          <TreeLevel
            key={treeKey}
            sessionId={sessionId}
            relPath=""
            depth={0}
            selected={findGroup(layout, focusedGroupId)?.active ?? null}
            onOpen={openFile}
            onChanged={refreshTree}
            git={git}
            onGitChanged={() => {
              refreshGit()
              refreshTree()
              useHang4r.getState().bumpGit()
            }}
            multiSel={selected}
            onFileClick={onFileClick}
            expanded={expanded}
            onToggle={toggleExpanded}
          />
        )}
          </>
        )}
    </div>
  )

  // recursive render: split node → a resizable Group of Panels; leaf → renderLeaf.
  // Panels are keyed by node identity (group id / split id) so reordering or
  // nesting never remounts an existing leaf. The ONE unavoidable remount is the
  // leaf being wrapped into a NEW split node — its content is safe via
  // CodeEditor's shared-dirty registry, and untouched sibling leaves keep their
  // unsaved edits (the always-Group-at-root shape below preserves the rest).
  const nodeKey = (n: LayoutNode): string => (n.kind === 'leaf' ? `g${n.group.id}` : `s${n.id}`)
  const renderNode = (node: LayoutNode): JSX.Element => {
    if (node.kind === 'leaf') return renderLeaf(node.group)
    return (
      <Group
        orientation={node.dir === 'v' ? 'vertical' : 'horizontal'}
        className="editor-split-group"
      >
        {node.children.map((child, i) => (
          <Fragment key={nodeKey(child)}>
            {i > 0 && (
              <Separator
                className={
                  'resize-handle ' + (node.dir === 'v' ? 'resize-handle-h' : 'resize-handle-v')
                }
              />
            )}
            <Panel minSize="10%" className="editor-panel">
              {renderNode(child)}
            </Panel>
          </Fragment>
        ))}
      </Group>
    )
  }
  // ALWAYS render a Group at the root — even a single leaf — via a synthetic
  // one-child split. The first real split then just flips the root Group's
  // orientation and appends a Panel instead of re-parenting the existing leaf
  // (re-parenting remounts it → reload from disk, killing unsaved edits).
  const rootNode: LayoutNode =
    layout.kind === 'split' ? layout : { kind: 'split', dir: 'h', id: -1, children: [layout] }
  const viewer = <div className="files-viewer">{renderNode(rootNode)}</div>

  return (
    <div className="files-view">
      {treeCollapsed ? (
        <>
          {/* slim rail keeps the toggles reachable while the tree is hidden */}
          <div className="files-rail">
            <button
              className="ghost-btn"
              title="Show file tree"
              onClick={() => {
                setTreeCollapsed(false)
                setMode('tree')
              }}
            >
              <Icon name="files" size={14} />
            </button>
            <button
              className="ghost-btn"
              title="Search in files (⌘⇧F)"
              onClick={() => {
                setTreeCollapsed(false)
                setMode('search')
              }}
            >
              <Icon name="search" size={13} />
            </button>
          </div>
          {viewer}
        </>
      ) : (
        <Group orientation="horizontal" className="files-split-group">
          <Panel minSize="12%" defaultSize="24%" className="files-tree-panel">
            {treeColumn}
          </Panel>
          <Separator className="resize-handle resize-handle-v" />
          <Panel minSize="30%" className="files-viewer-panel">
            {viewer}
          </Panel>
        </Group>
      )}
    </div>
  )
}

type GitMap = Record<string, { badge: string; staged: boolean }>

const BADGE_COLOR: Record<string, string> = {
  M: '#e2c08d', // modified — ochre
  A: '#73c991', // added — green
  U: '#73c991', // untracked — green
  D: '#c74e39', // deleted — red
  R: '#74b6cc', // renamed — cyan
  C: '#e4676b' // conflict — red-orange
}

function TreeLevel({
  sessionId,
  relPath,
  depth,
  selected,
  onOpen,
  onChanged,
  git,
  onGitChanged,
  multiSel,
  onFileClick,
  expanded,
  onToggle
}: {
  sessionId: string
  relPath: string
  depth: number
  selected: string | null
  onOpen: (path: string) => void
  onChanged: () => void
  git: GitMap
  onGitChanged: () => void
  multiSel: Set<string>
  onFileClick: (
    ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
    path: string,
    siblings: string[]
  ) => void
  /** expansion state lifted to FileBrowser (survives refresh; cleared by collapse-all) */
  expanded: Set<string>
  onToggle: (path: string) => void
}): JSX.Element {
  const fileSiblings = (entriesArg: DirEntry[]): string[] =>
    entriesArg.filter((x) => !x.isDir).map((x) => x.path)
  const [entries, setEntries] = useState<DirEntry[] | null>(null)

  useEffect(() => {
    void window.hang4r.listDir(sessionId, relPath).then(setEntries)
  }, [sessionId, relPath])

  if (!entries) return <div className="files-loading" style={{ paddingLeft: depth * 12 + 8 }}>…</div>

  return (
    <>
      {entries.map((e) =>
        e.isDir ? (
          <div key={e.path}>
            <button
              className="file-row"
              style={{ paddingLeft: depth * 12 + 8 }}
              onClick={() => onToggle(e.path)}
              onContextMenu={(ev) => {
                ev.preventDefault()
                const store = useHang4r.getState()
                store.openContextMenu(ev.clientX, ev.clientY, [
                  {
                    label: 'New File…',
                    onClick: () =>
                      void store.showPrompt('New file name:').then((n) => {
                        if (n?.trim())
                          void window.hang4r
                            .createFile(sessionId, `${e.path}/${n.trim()}`)
                            .then(onChanged)
                      })
                  },
                  {
                    label: 'New Folder…',
                    onClick: () =>
                      void store.showPrompt('New folder name:').then((n) => {
                        if (n?.trim())
                          void window.hang4r
                            .createDir(sessionId, `${e.path}/${n.trim()}`)
                            .then(onChanged)
                      })
                  },
                  { label: 'Copy path', onClick: () => void navigator.clipboard.writeText(e.path) },
                  { separator: true, label: '' },
                  {
                    label: 'Rename…',
                    onClick: () =>
                      void store.showPrompt('Rename folder to:', e.path).then((to) => {
                        if (to?.trim() && to.trim() !== e.path)
                          void window.hang4r.renamePath(sessionId, e.path, to.trim()).then(onChanged)
                      })
                  },
                  {
                    label: 'Delete',
                    danger: true,
                    onClick: () =>
                      void store.showConfirm(`Delete folder ${e.path} and its contents?`).then((ok) => {
                        if (ok) void window.hang4r.removePath(sessionId, e.path).then(onChanged)
                      })
                  }
                ])
              }}
            >
              <span className="file-caret">{expanded.has(e.path) ? '▾' : '▸'}</span>
              <span className="file-icon file-icon-folder"><Icon name="folder" size={13} /></span>
              <span className="file-name">{e.name}</span>
              {Object.keys(git).some((p) => p.startsWith(e.path + '/')) && (
                <span className="git-folder-dot" title="Contains changes" />
              )}
            </button>
            {expanded.has(e.path) && (
              <TreeLevel
                sessionId={sessionId}
                relPath={e.path}
                depth={depth + 1}
                selected={selected}
                onOpen={onOpen}
                onChanged={onChanged}
                git={git}
                onGitChanged={onGitChanged}
                multiSel={multiSel}
                onFileClick={onFileClick}
                expanded={expanded}
                onToggle={onToggle}
              />
            )}
          </div>
        ) : (
          <button
            key={e.path}
            className={
              'file-row' +
              (e.path === selected ? ' file-row-active' : '') +
              (multiSel.has(e.path) ? ' file-row-selected' : '')
            }
            style={{ paddingLeft: depth * 12 + 20 }}
            draggable
            onDragStart={(ev) => {
              // drag a file onto the composer to attach it as context
              ev.dataTransfer.setData('application/x-hang4r-file', e.path)
              ev.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={(ev) => onFileClick(ev, e.path, fileSiblings(entries))}
            onContextMenu={(ev) => {
              ev.preventDefault()
              const store = useHang4r.getState()
              const st = git[e.path]
              // batch menu when this row is part of a multi-selection
              if (multiSel.size > 1 && multiSel.has(e.path)) {
                const paths = [...multiSel]
                store.openContextMenu(ev.clientX, ev.clientY, [
                  {
                    label: `Add ${paths.length} files to chat`,
                    onClick: () => {
                      for (const p of paths)
                        void window.hang4r.readFile(sessionId, p).then((r) =>
                          store.addAttachment(sessionId, {
                            label: p.split('/').pop() ?? p,
                            text: `${p}\n${r.content.slice(0, 4000)}`
                          })
                        )
                    }
                  },
                  {
                    label: `Delete ${paths.length} files`,
                    danger: true,
                    onClick: () =>
                      void store.showConfirm(`Delete ${paths.length} files?`).then((ok) => {
                        if (ok)
                          Promise.all(paths.map((p) => window.hang4r.removePath(sessionId, p))).then(
                            onChanged
                          )
                      })
                  }
                ])
                return
              }
              store.openContextMenu(ev.clientX, ev.clientY, [
                { label: 'Open', onClick: () => onOpen(e.path) },
                {
                  label: 'Open Changes',
                  onClick: () => {
                    store.focusSession(sessionId)
                    store.openDiffFor(sessionId, e.path)
                  }
                },
                { separator: true, label: '' },
                ...(st
                  ? st.staged
                    ? [
                        {
                          label: 'Unstage Changes',
                          onClick: () =>
                            void window.hang4r.gitUnstage(sessionId, e.path).then(onGitChanged)
                        }
                      ]
                    : [
                        {
                          label: 'Stage Changes',
                          onClick: () =>
                            void window.hang4r.gitStage(sessionId, e.path).then(onGitChanged)
                        },
                        {
                          label: 'Discard Changes',
                          danger: true,
                          onClick: () =>
                            void store
                              .showConfirm(`Discard changes to ${e.name}? This cannot be undone.`)
                              .then((ok) => {
                                if (ok)
                                  void window.hang4r.gitDiscard(sessionId, e.path).then(onGitChanged)
                              })
                        }
                      ]
                  : []),
                ...(st ? [{ separator: true, label: '' }] : []),
                {
                  label: 'Add to chat',
                  onClick: () =>
                    void window.hang4r.readFile(sessionId, e.path).then((r) =>
                      store.addAttachment(sessionId, {
                        label: e.name,
                        text: `${e.path}\n${r.content.slice(0, 4000)}`
                      })
                    )
                },
                { label: 'Copy path', onClick: () => void navigator.clipboard.writeText(e.path) },
                { separator: true, label: '' },
                {
                  label: 'Rename…',
                  onClick: () => {
                    void useHang4r
                      .getState()
                      .showPrompt('Rename to (path):', e.path)
                      .then((to) => {
                        if (to?.trim() && to.trim() !== e.path)
                          void window.hang4r.renamePath(sessionId, e.path, to.trim()).then(onChanged)
                      })
                  }
                },
                {
                  label: 'Delete',
                  danger: true,
                  onClick: () => {
                    void useHang4r
                      .getState()
                      .showConfirm(`Delete ${e.path}?`)
                      .then((ok) => {
                        if (ok) void window.hang4r.removePath(sessionId, e.path).then(onChanged)
                      })
                  }
                }
              ])
            }}
          >
            <FileGlyph fi={fileIcon(e.name)} />
            <span
              className="file-name"
              style={git[e.path] ? { color: BADGE_COLOR[git[e.path].badge] } : undefined}
            >
              {e.name}
            </span>
            {git[e.path] && (
              <span className="git-row-actions">
                {git[e.path].staged ? (
                  <span
                    className="git-act"
                    title="Unstage"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void window.hang4r.gitUnstage(sessionId, e.path).then(onGitChanged)
                    }}
                  >
                    −
                  </span>
                ) : (
                  <>
                    <span
                      className="git-act"
                      title="Stage"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void window.hang4r.gitStage(sessionId, e.path).then(onGitChanged)
                      }}
                    >
                      +
                    </span>
                    <span
                      className="git-act git-act-discard"
                      title="Discard"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void useHang4r
                          .getState()
                          .showConfirm(`Discard changes to ${e.name}? This cannot be undone.`)
                          .then((ok) => {
                            if (ok)
                              void window.hang4r.gitDiscard(sessionId, e.path).then(onGitChanged)
                          })
                      }}
                    >
                      ⟲
                    </span>
                  </>
                )}
                <span
                  className="git-badge"
                  style={{ color: BADGE_COLOR[git[e.path].badge] }}
                  title={git[e.path].staged ? 'staged' : 'working tree'}
                >
                  {git[e.path].badge}
                </span>
              </span>
            )}
          </button>
        )
      )}
    </>
  )
}
