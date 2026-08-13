import type { JSX } from 'react'
import { useApp } from './state/store'
import { PairScreen } from './screens/PairScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SessionScreen } from './screens/SessionScreen'
import { NewSessionScreen } from './screens/NewSessionScreen'
import { UsageScreen } from './screens/UsageScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export function App(): JSX.Element {
  const pairingUrl = useApp((s) => s.pairingUrl)
  const openSessionId = useApp((s) => s.openSessionId)
  const screen = useApp((s) => s.screen)

  if (!pairingUrl) return <PairScreen />
  if (openSessionId) return <SessionScreen />
  if (screen === 'new') return <NewSessionScreen />
  if (screen === 'usage') return <UsageScreen />
  if (screen === 'settings') return <SettingsScreen />
  return <HomeScreen />
}
