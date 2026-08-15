/**
 * Registry that connects each session tile's Browser SLOT (an empty placeholder
 * div rendered by SessionTile) to the app-level BrowserLayer, which overlays the
 * real, kept-alive <webview> on top of it.
 *
 * Why: hang4r is single-open — switching sessions UNMOUNTS the previous
 * SessionTile, which used to unmount BrowserPane and destroy its <webview>, so
 * returning reloaded the page (lost scroll/form/history — Angel, repeatedly).
 * The webview now lives in a persistent layer that never unmounts on a session
 * switch; the tile only reports WHERE its browser region is (this registry) so
 * the layer can position the matching webview over it.
 *
 * Geometry is read imperatively from the registered element (getBoundingClientRect),
 * never through React state, so panel drags / resizes don't re-render anything.
 */

type Listener = () => void

const slots = new Map<string, HTMLElement>()
const listeners = new Set<Listener>()

// A cached, stable snapshot of the registered session ids so useSyncExternalStore
// gets a referentially-stable array between actual changes (a fresh array every
// call would loop React #185).
let cachedIds: string[] = []
let cachedKey = ''

function recompute(): void {
  const key = Array.from(slots.keys()).sort().join(',')
  if (key !== cachedKey) {
    cachedKey = key
    cachedIds = key ? key.split(',') : []
    listeners.forEach((f) => f())
  }
}

export function registerBrowserSlot(sessionId: string, el: HTMLElement): void {
  slots.set(sessionId, el)
  recompute()
}

/** Only clears the mapping if THIS element is still the registered one — guards
 *  the unmount/remount race where a remount registers before the old unmounts. */
export function unregisterBrowserSlot(sessionId: string, el: HTMLElement): void {
  if (slots.get(sessionId) === el) {
    slots.delete(sessionId)
    recompute()
  }
}

export function getBrowserSlot(sessionId: string): HTMLElement | undefined {
  return slots.get(sessionId)
}

/** Referentially-stable list of session ids with a live browser slot. */
export function getBrowserSlotIds(): string[] {
  return cachedIds
}

export function subscribeBrowserSlots(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
