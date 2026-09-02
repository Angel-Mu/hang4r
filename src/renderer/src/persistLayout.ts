import type { ComponentProps } from 'react'
import type { Group } from 'react-resizable-panels'

type Layout = Parameters<NonNullable<ComponentProps<typeof Group>['onLayoutChanged']>>[0]

/**
 * Remember a resizable split across remounts.
 *
 * Every Panel in the group needs an explicit `id`. Without one the library keys
 * the saved layout by the ids React generates (_r_3_), which are fresh on every
 * mount — a tile that remounts on a session switch then looks up keys that no
 * longer exist and silently falls back to its defaults, which is exactly what a
 * saved-and-never-read layout looks like from the outside.
 *
 * `variant` separates layouts whose panel COUNT differs: restoring a two-panel
 * layout into a one-panel group throws off the sizes.
 *
 * Callers key by session: a width that suits a session with the editor open is
 * the wrong width for one without it, so sharing a single layout meant resizing
 * anywhere silently re-laid-out everything else.
 */
export function persistedLayout(key: string, variant: string | number = ''): Layout | undefined {
  try {
    const raw = localStorage.getItem(`hang4r:split:${key}:${variant}`)
    return raw ? (JSON.parse(raw) as Layout) : undefined
  } catch {
    return undefined
  }
}

export function savePersistedLayout(key: string, variant: string | number, layout: Layout): void {
  try {
    localStorage.setItem(`hang4r:split:${key}:${variant}`, JSON.stringify(layout))
  } catch {
    /* private window / storage disabled — the split just does not persist */
  }
}
