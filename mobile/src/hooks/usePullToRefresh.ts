import { useEffect, useRef, useState } from 'react'

/**
 * Pull-to-refresh for a DOM scroller (WKWebView gives no native PTR for
 * overflow divs). Pull ≥70px from the very top → onRefresh; the returned
 * `pull` drives the indicator (0 while idle).
 */
export function usePullToRefresh<T extends HTMLElement>(
  onRefresh: () => Promise<void> | void
): { ref: React.RefObject<T | null>; pull: number; active: boolean } {
  const ref = useRef<T>(null)
  const [pull, setPull] = useState(0)
  const [active, setActive] = useState(false)
  const cb = useRef(onRefresh)
  cb.current = onRefresh

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startY = 0
    let pulling = false

    const onStart = (e: TouchEvent): void => {
      pulling = el.scrollTop <= 0
      startY = e.touches[0].clientY
    }
    const onMove = (e: TouchEvent): void => {
      if (!pulling) return
      const dy = e.touches[0].clientY - startY
      if (dy <= 0 || el.scrollTop > 0) {
        setPull(0)
        return
      }
      // rubber-band: displayed pull grows slower than the finger
      setPull(Math.min(110, dy * 0.45))
    }
    const onEnd = (): void => {
      if (!pulling) return
      pulling = false
      setPull((p) => {
        if (p >= 60) {
          setActive(true)
          void Promise.resolve(cb.current()).finally(() => {
            setActive(false)
          })
        }
        return 0
      })
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
    }
  }, [])

  return { ref, pull, active }
}
