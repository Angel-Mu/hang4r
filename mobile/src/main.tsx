import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { App } from './App'
import { useApp, tryBridge } from './state/store'
import './styles.css'

if (Capacitor.isNativePlatform()) {
  // native status bar text follows the resolved theme
  void import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
    const sync = (): void => {
      const dark = document.documentElement.dataset.theme !== 'light'
      void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    }
    sync()
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
  })

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
  // nothing to be notified about, so no cold-open permission prompt. Every
  // failure lands in pushStatus (Settings shows it): the first field test
  // failed with zero symptoms because errors were swallowed here.
  let pushArmed = false
  const armPush = (): void => {
    if (pushArmed || !useApp.getState().pairingUrl || !useApp.getState().pushEnabled) return
    pushArmed = true
    void (async () => {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications')
        await PushNotifications.addListener('registration', ({ value }) => {
          useApp.getState().setApnsToken(value)
        })
        await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const sid = (action.notification.data as { sessionId?: string } | undefined)?.sessionId
          if (sid) useApp.getState().openSessionWhenReady(sid)
        })
        await PushNotifications.addListener('registrationError', (err) => {
          useApp.getState().setPushStatus(`registration failed: ${JSON.stringify(err)}`)
        })
        const perm = await PushNotifications.requestPermissions()
        useApp.getState().setPushStatus(`permission ${perm.receive}`)
        if (perm.receive === 'granted') await PushNotifications.register()
      } catch (err) {
        pushArmed = false
        useApp.getState().setPushStatus(`error: ${err instanceof Error ? err.message : err}`)
      }
    })()
  }
  armPush()
  useApp.subscribe((s, prev) => {
    if (s.pairingUrl && !prev.pairingUrl) armPush()
  })

  // resume: iOS froze the webview — the socket is dead and everything that
  // streamed meanwhile is gone from the wire. Reconnect + replay immediately
  // instead of waiting for the stale socket to time out.
  void CapApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return
    armPush()
    tryBridge()?.checkAlive()
    const app = useApp.getState()
    if (app.conn === 'online') {
      void app.refresh()
      void app.reloadOpenTranscript()
    }
    // dead-socket case: checkAlive closes the corpse, onclose reconnects, and
    // the 'online' transition re-runs the same refresh + replay
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
