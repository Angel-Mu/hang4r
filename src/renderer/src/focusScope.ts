/**
 * Which PANE the user is currently working in — the single source of truth for
 * scoping keyboard shortcuts.
 *
 * The recurring "you mess up the scope" bug class (Angel) came from routing
 * pane-scoped shortcuts (⌘N new file, ⌘W close, ⌘\ split, terminal ⌘D/⌘[/⌘],
 * browser ⌘T/⌘L/⌘R/…) by which TILE is focused: a panel merely being OPEN in the
 * focused tile fired its action while you were reading or typing in the
 * conversation. The fix is to route by where focus actually is, consistently.
 *
 * Cases, in order:
 *   1. `<body>` / nothing focused → `'other'`. Clicking non-focusable
 *      conversation text drops focus to `<body>`, and a shortcut there must mean
 *      the conversation (matches the ⌘F capture handler), never a background
 *      pane.
 *   2. Focus literally inside a pane → that pane. (`.terminal-view` and
 *      `.browser-pane` nest inside `.context-panel`, so they're checked before
 *      the Files panel `.files-view`.)
 *   3. Focus in the conversation (`.chat-panel` — the composer or the transcript)
 *      → `'other'`. This is the bug: a panel being open must not steal a key you
 *      typed into the chat.
 *   4. Focus outside the focused tile (the sidebar, a dialog) → `'other'`.
 *   5. Otherwise — neutral chrome INSIDE the tile: a panel's tab button (focus
 *      lands there when you click it open) or the panel header — maps to whatever
 *      pane is currently VISIBLE in the focused tile. Panels aren't auto-focused
 *      on open, so this is what keeps "open Files → ⌘N", "open Terminal → ⌘D",
 *      "open Browser → ⌘L" working the instant the panel appears.
 */
export type FocusPane = 'editor' | 'terminal' | 'browser' | 'other'

export function focusPane(): FocusPane {
  const a = document.activeElement as HTMLElement | null
  if (!a || a === document.body) return 'other' // 1
  if (a.closest('.terminal-view')) return 'terminal' // 2
  if (a.closest('.browser-pane')) return 'browser'
  if (a.closest('.files-view')) return 'editor'
  if (a.closest('.chat-panel')) return 'other' // 3
  if (!a.closest('.tile')) return 'other' // 4
  return visiblePane() // 5
}

/** The pane VISIBLE in the focused tile's context panel. `offsetParent === null`
 *  filters the persistently-mounted-but-hidden Browser (`display:none`). */
function visiblePane(): FocusPane {
  const cp = document.querySelector('.tile-focused .context-panel')
  if (cp) {
    const vis = (sel: string): boolean => {
      const el = cp.querySelector(sel) as HTMLElement | null
      return !!el && el.offsetParent !== null
    }
    if (vis('.terminal-view')) return 'terminal'
    if (vis('.browser-pane')) return 'browser'
    if (vis('.files-view')) return 'editor'
  }
  return 'other'
}
