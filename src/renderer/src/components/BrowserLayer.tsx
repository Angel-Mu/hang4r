import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type JSX
} from 'react'
import { useHang4r } from '../state/store'
import { BrowserPane } from './BrowserPane'
import {
  getBrowserSlot,
  getBrowserSlotIds,
  registerBrowserSlot,
  subscribeBrowserSlots,
  unregisterBrowserSlot
} from '../browserSlots'

/**
 * The empty placeholder a SessionTile renders where its Browser panel goes. It
 * only reports its position (via the slot registry) — the real BrowserPane +
 * <webview> is drawn by the app-level BrowserLayer, overlaid on top of this.
 */
export function BrowserSlot({ sessionId }: { sessionId: string }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  // useLayoutEffect so the slot is registered before paint — the layer's own
  // layout-effect then positions the overlay in the same commit, no flash.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    registerBrowserSlot(sessionId, el)
    return () => unregisterBrowserSlot(sessionId, el)
  }, [sessionId])
  return <div className="browser-slot" data-session={sessionId} ref={ref} />
}

/**
 * App-level layer that holds a POOL of BrowserPanes — one per session that has a
 * live browser — that survives session switches (tile unmount/remount). Each
 * pane is absolutely positioned (position: fixed) over the visible tile's
 * browser SLOT; a session whose slot isn't currently on screen is hidden
 * (display:none) but stays MOUNTED, so its <webview> keeps its page, scroll,
 * form state and history instead of reloading.
 *
 * A pane is mounted for a session while it has browser tabs in the store OR a
 * slot on screen (first open, before the empty seed tab exists), and only truly
 * disposed when the session is closed/deleted (it leaves s.sessions) — at which
 * point BrowserPane's own unmount cleanup fires (guests cleared, devtools torn
 * down).
 */
export function BrowserLayer(): JSX.Element {
  // session ids that currently have a browser slot rendered (contextTab==='Browser')
  const slotIds = useSyncExternalStore(subscribeBrowserSlots, getBrowserSlotIds)
  // sessions that already have browser tabs (keep their webview alive across switches)
  const tabKeysStr = useHang4r((s) => Object.keys(s.browserTabs).sort().join(','))
  // only mount panes for sessions that still exist (a deleted/archived session
  // must drop its webview) — primitive string keeps this from re-rendering on
  // every unrelated session update
  const sessionIdsStr = useHang4r((s) => s.sessions.map((x) => x.id).sort().join(','))

  const existing = new Set(sessionIdsStr ? sessionIdsStr.split(',') : [])
  const tabKeys = tabKeysStr ? tabKeysStr.split(',') : []
  const slotSet = new Set(slotIds)
  const mountIds = Array.from(new Set([...slotIds, ...tabKeys]))
    .filter((id) => existing.has(id))
    .sort()
  const mountKey = mountIds.join(',')
  const slotKey = slotIds.join(',')

  const overlayEls = useRef(new Map<string, HTMLDivElement>())
  const lastApplied = useRef(new Map<string, string>())

  /** glue each overlay to its slot's current viewport rect (or hide it) */
  const sync = useCallback((): void => {
    for (const [sid, el] of overlayEls.current) {
      const slot = getBrowserSlot(sid)
      const visible = !!slot && slot.offsetParent !== null && slot.getClientRects().length > 0
      if (!visible) {
        if (el.style.display !== 'none') {
          el.style.display = 'none'
          lastApplied.current.delete(sid)
        }
        continue
      }
      const r = slot!.getBoundingClientRect()
      const key = `${r.left}|${r.top}|${r.width}|${r.height}`
      if (el.style.display !== 'none' && lastApplied.current.get(sid) === key) continue
      lastApplied.current.set(sid, key)
      el.style.display = 'flex'
      el.style.left = `${r.left}px`
      el.style.top = `${r.top}px`
      el.style.width = `${r.width}px`
      el.style.height = `${r.height}px`
    }
  }, [])

  // position synchronously before paint whenever the mounted set or the visible
  // slots change (opening/closing the panel, switching sessions) — no flash, and
  // the overlay is already placed by the time an e2e interaction fires
  useLayoutEffect(() => {
    sync()
  }, [mountKey, slotKey, sync])

  // keep the overlays glued to their slots as the layout shifts: ResizeObserver
  // catches panel-drag / window resizes; the low-frequency poll catches
  // POSITION-only shifts that don't resize the slot (sidebar toggle, tile move) —
  // the same belt-and-braces the docked-devtools overlay uses.
  useEffect(() => {
    if (overlayEls.current.size === 0) return
    let raf = 0
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0
        sync()
      })
    }
    sync()
    const ro = new ResizeObserver(schedule)
    for (const sid of slotIds) {
      const el = getBrowserSlot(sid)
      if (el) ro.observe(el)
    }
    const appBody = document.querySelector('.app-body')
    if (appBody) ro.observe(appBody)
    window.addEventListener('resize', schedule)
    const iv = window.setInterval(sync, 200)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      clearInterval(iv)
    }
  }, [mountKey, slotKey, sync])

  return (
    <div className="browser-layer" aria-hidden={mountIds.length === 0}>
      {mountIds.map((sid) => (
        <div
          key={sid}
          className="browser-overlay"
          ref={(el) => {
            if (el) overlayEls.current.set(sid, el)
            else {
              overlayEls.current.delete(sid)
              lastApplied.current.delete(sid)
            }
          }}
        >
          <BrowserPane sessionId={sid} visible={slotSet.has(sid)} />
        </div>
      ))}
    </div>
  )
}
