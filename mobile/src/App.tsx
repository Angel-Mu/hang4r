import { useEffect, useRef, useState, type JSX } from 'react'
import { useApp } from './state/store'
import { PairScreen } from './screens/PairScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SessionScreen } from './screens/SessionScreen'
import { NewSessionScreen } from './screens/NewSessionScreen'
import { UsageScreen } from './screens/UsageScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { PushScreen, NavProvider } from './components/PushScreen'

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 700px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 700px)')
    const on = (): void => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

/** Swipe left anywhere on the sessions column tucks it away (toggle restores). */
function useSwipeHide(onHide: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef(onHide)
  cb.current = onHide
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let sx = 0
    let sy = 0
    const onStart = (e: TouchEvent): void => {
      sx = e.touches[0].clientX
      sy = e.touches[0].clientY
    }
    const onMove = (e: TouchEvent): void => {
      const dx = e.touches[0].clientX - sx
      const dy = Math.abs(e.touches[0].clientY - sy)
      if (dx < -60 && dy < 40) cb.current()
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

/**
 * Phone: Home stays mounted under pushed panels (native-stack feel, scroll
 * preserved). iPad/wide: split view — sessions column (hideable: swipe left
 * or the panel toggle) + conversation detail; secondary screens still push.
 */
export function App(): JSX.Element {
  const pairingUrl = useApp((s) => s.pairingUrl)
  const openSessionId = useApp((s) => s.openSessionId)
  const screen = useApp((s) => s.screen)
  const closeSession = useApp((s) => s.closeSession)
  const setScreen = useApp((s) => s.setScreen)
  const wide = useWide()
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const masterRef = useSwipeHide(() => setSidebarHidden(true))

  if (!pairingUrl) return <PairScreen />

  const overlays = (
    <>
      {screen === 'new' && (
        <PushScreen onClosed={() => setScreen('home')}>
          <NewSessionScreen />
        </PushScreen>
      )}
      {screen === 'usage' && (
        <PushScreen onClosed={() => setScreen('home')}>
          <UsageScreen />
        </PushScreen>
      )}
      {screen === 'settings' && (
        <PushScreen onClosed={() => setScreen('home')}>
          <SettingsScreen />
        </PushScreen>
      )}
    </>
  )

  if (wide) {
    return (
      <div className="split">
        <div
          ref={masterRef}
          className={'split-master' + (sidebarHidden ? ' split-master-hidden' : '')}
        >
          <HomeScreen />
        </div>
        <div className="split-detail">
          {openSessionId ? (
            <NavProvider back={closeSession}>
              <SessionScreen
                key={openSessionId}
                sidebarHidden={sidebarHidden}
                onToggleSidebar={() => setSidebarHidden((h) => !h)}
              />
            </NavProvider>
          ) : (
            <div className="split-empty">
              {sidebarHidden && (
                <button
                  className="btn btn-ghost split-restore"
                  onClick={() => setSidebarHidden(false)}
                >
                  Show sessions
                </button>
              )}
              <p className="empty-note split-placeholder">Select a session</p>
            </div>
          )}
        </div>
        {overlays}
      </div>
    )
  }

  return (
    <>
      <HomeScreen />
      {overlays}
      {openSessionId && (
        <PushScreen key={openSessionId} onClosed={closeSession}>
          <SessionScreen />
        </PushScreen>
      )}
    </>
  )
}
