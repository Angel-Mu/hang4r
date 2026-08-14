import type { JSX } from 'react'
import { useApp } from './state/store'
import { PairScreen } from './screens/PairScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SessionScreen } from './screens/SessionScreen'
import { NewSessionScreen } from './screens/NewSessionScreen'
import { UsageScreen } from './screens/UsageScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { PushScreen } from './components/PushScreen'

/** Home stays mounted under every pushed panel: back never loses its scroll
 *  position, and panels slide over it like a native navigation stack. */
export function App(): JSX.Element {
  const pairingUrl = useApp((s) => s.pairingUrl)
  const openSessionId = useApp((s) => s.openSessionId)
  const screen = useApp((s) => s.screen)
  const closeSession = useApp((s) => s.closeSession)
  const setScreen = useApp((s) => s.setScreen)

  if (!pairingUrl) return <PairScreen />
  return (
    <>
      <HomeScreen />
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
      {openSessionId && (
        <PushScreen key={openSessionId} onClosed={closeSession}>
          <SessionScreen />
        </PushScreen>
      )}
    </>
  )
}
