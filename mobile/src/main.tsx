import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { App } from './App'
import { useApp } from './state/store'
import './styles.css'

if (Capacitor.isNativePlatform()) {
  // Keyboard.resize='body' shrinks the webview, but the layout still pads for
  // the (now hidden) home-indicator safe area — that stack-up is the visible
  // gap between the composer and the keyboard. Drop the inset while open.
  void import('@capacitor/keyboard').then(({ Keyboard }) => {
    void Keyboard.addListener('keyboardWillShow', () => {
      document.documentElement.classList.add('kb-open')
    })
    void Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.classList.remove('kb-open')
    })
  })

  // hang4r://pair?… deep link: tapping the pairing link (or simctl openurl)
  // pairs without the camera — both warm-start and cold-start paths
  void CapApp.addListener('appUrlOpen', ({ url }) => {
    if (url.startsWith('hang4r://pair')) useApp.getState().pair(url)
  })
  void CapApp.getLaunchUrl().then((launch) => {
    if (launch?.url.startsWith('hang4r://pair')) useApp.getState().pair(launch.url)
  })

  // push registration only once a computer is paired — an unpaired app has
  // nothing to be notified about, so no cold-open permission prompt
  let pushArmed = false
  const armPush = (): void => {
    if (pushArmed || !useApp.getState().pairingUrl) return
    pushArmed = true
    void import('@capacitor/push-notifications').then(async ({ PushNotifications }) => {
      await PushNotifications.addListener('registration', ({ value }) => {
        useApp.getState().setApnsToken(value)
      })
      const perm = await PushNotifications.requestPermissions()
      if (perm.receive === 'granted') await PushNotifications.register()
    })
  }
  armPush()
  useApp.subscribe((s, prev) => {
    if (s.pairingUrl && !prev.pairingUrl) armPush()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
