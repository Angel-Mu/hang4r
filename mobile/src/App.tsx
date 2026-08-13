import type { JSX } from 'react'
import { useApp } from './state/store'
import { PairScreen } from './screens/PairScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SessionScreen } from './screens/SessionScreen'

export function App(): JSX.Element {
  const pairingUrl = useApp((s) => s.pairingUrl)
  const openSessionId = useApp((s) => s.openSessionId)

  if (!pairingUrl) return <PairScreen />
  if (openSessionId) return <SessionScreen />
  return <HomeScreen />
}
