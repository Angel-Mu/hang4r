import { useEffect, useState, type JSX } from 'react'
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

/**
 * Phone: Home stays mounted under pushed panels (native-stack feel, scroll
 * preserved). iPad/wide: split view — sessions on the left, the open
 * conversation beside it; secondary screens still push over everything.
 */
export function App(): JSX.Element {
  const pairingUrl = useApp((s) => s.pairingUrl)
  const openSessionId = useApp((s) => s.openSessionId)
  const screen = useApp((s) => s.screen)
  const closeSession = useApp((s) => s.closeSession)
  const setScreen = useApp((s) => s.setScreen)
  const wide = useWide()

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
        <div className="split-master">
          <HomeScreen />
        </div>
        <div className="split-detail">
          {openSessionId ? (
            <NavProvider back={closeSession}>
              <SessionScreen key={openSessionId} />
            </NavProvider>
          ) : (
            <p className="empty-note split-placeholder">Select a session</p>
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
