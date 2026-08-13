import { useEffect, useRef } from 'react'

/**
 * iOS-style edge swipe-back for a screen root. WKWebView has no native back
 * stack to hook, so this reimplements the standard gesture: touch starts in
 * the left 32px, moves right ≥70px with mostly-horizontal travel → onBack.
 * A visible Back control must always exist too (gesture-alternative rule).
 */
export function useSwipeBack<T extends HTMLElement>(onBack: () => void): React.RefObject<T | null> {
  const ref = useRef<T>(null)
  const cb = useRef(onBack)
  cb.current = onBack

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startX = 0
    let startY = 0
    let armed = false

    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0]
      armed = t.clientX <= 32
      startX = t.clientX
      startY = t.clientY
    }
    const onMove = (e: TouchEvent): void => {
      if (!armed) return
      const t = e.touches[0]
      const dx = t.clientX - startX
      const dy = Math.abs(t.clientY - startY)
      if (dx > 70 && dx > dy * 2) {
        armed = false
        cb.current()
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
    }
  }, [])

  return ref
}
