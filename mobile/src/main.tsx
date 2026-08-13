import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { App } from './App'
import { useApp } from './state/store'
import './styles.css'

if (Capacitor.isNativePlatform()) {
  // hang4r://pair?… deep link: tapping the pairing link (or simctl openurl)
  // pairs without the camera — both warm-start and cold-start paths
  void CapApp.addListener('appUrlOpen', ({ url }) => {
    if (url.startsWith('hang4r://pair')) useApp.getState().pair(url)
  })
  void CapApp.getLaunchUrl().then((launch) => {
    if (launch?.url.startsWith('hang4r://pair')) useApp.getState().pair(launch.url)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
