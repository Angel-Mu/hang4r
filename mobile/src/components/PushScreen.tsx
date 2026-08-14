import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'

interface Nav {
  /** animate the panel out, then run the owner's close action */
  back: () => void
}

const NavContext = createContext<Nav>({ back: () => {} })
export function useNav(): Nav {
  return useContext(NavContext)
}

const EXIT_MS = 220

/**
 * iOS-style pushed panel: slides in over the base screen (which stays mounted,
 * keeping its scroll position), slides out on back, and tracks the finger for
 * the edge swipe-back gesture. Screens inside call useNav().back() instead of
 * mutating navigation state directly, so every exit is animated.
 */
export function PushScreen({
  onClosed,
  children
}: {
  onClosed: () => void
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [leaving, setLeaving] = useState(false)
  const closedRef = useRef(onClosed)
  closedRef.current = onClosed

  const back = useCallback((): void => {
    setLeaving(true)
    setTimeout(() => closedRef.current(), EXIT_MS)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startX = 0
    let startY = 0
    let dragging = false
    let dx = 0

    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0]
      dragging = t.clientX <= 32
      startX = t.clientX
      startY = t.clientY
      dx = 0
      if (dragging) el.style.transition = 'none'
    }
    const onMove = (e: TouchEvent): void => {
      if (!dragging) return
      const t = e.touches[0]
      dx = Math.max(0, t.clientX - startX)
      if (Math.abs(t.clientY - startY) > 60 && dx < 30) {
        dragging = false
        el.style.transition = ''
        el.style.transform = ''
        return
      }
      el.style.transform = `translateX(${dx}px)`
    }
    const onEnd = (): void => {
      if (!dragging) return
      dragging = false
      el.style.transition = ''
      if (dx > 90) {
        el.style.transform = 'translateX(100%)'
        setTimeout(() => closedRef.current(), EXIT_MS)
      } else {
        el.style.transform = ''
      }
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

  return (
    <NavContext.Provider value={{ back }}>
      <div ref={ref} className={'push-screen' + (leaving ? ' push-leave' : '')}>
        {children}
      </div>
    </NavContext.Provider>
  )
}
