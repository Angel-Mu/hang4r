import { useEffect, useState, type JSX } from 'react'
import { parsePairingUrl } from '@shared/bridge'
import { bridge, useApp } from '../state/store'
import { useSwipeBack } from '../hooks/useSwipeBack'

export function SettingsScreen(): JSX.Element {
  const rootRef = useSwipeBack<HTMLDivElement>(() => useApp.getState().setScreen('home'))
  const setScreen = useApp((s) => s.setScreen)
  const unpair = useApp((s) => s.unpair)
  const conn = useApp((s) => s.conn)
  const pairingUrl = useApp((s) => s.pairingUrl)
  const pushStatus = useApp((s) => s.pushStatus)
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null)
  const [confirmUnpair, setConfirmUnpair] = useState(false)

  const pairing = pairingUrl ? parsePairingUrl(pairingUrl) : null

  useEffect(() => {
    if (conn === 'online')
      void bridge()
        .call<string>('appVersion')
        .then(setDesktopVersion)
        .catch(() => {})
  }, [conn])

  return (
    <div className="screen" ref={rootRef}>
      <header className="topbar">
        <button className="btn btn-ghost" onClick={() => setScreen('home')}>
          ‹ Back
        </button>
        <span className="topbar-title">Settings</span>
      </header>
      <main className="form-screen">
        <section className="usage-card">
          <h2 className="usage-title">Paired computer</h2>
          <p className="usage-line">
            {conn === 'online'
              ? `🟢 online${desktopVersion ? ` · hang4r ${desktopVersion}` : ''}`
              : conn === 'relay'
                ? '🟠 desktop offline'
                : '⚪ connecting…'}
          </p>
          {pairing && (
            <>
              <p className="usage-line usage-dim">device {pairing.deviceId.slice(0, 8)}…</p>
              <p className="usage-line usage-dim">{pairing.relay.replace('wss://', '')}</p>
            </>
          )}
        </section>
        <section className="usage-card">
          <h2 className="usage-title">This app</h2>
          <p className="usage-line usage-dim">hang4r mobile 0.1.0</p>
          <p className="usage-line usage-dim">Push notifications: {pushStatus}</p>
        </section>
        {confirmUnpair ? (
          <section className="usage-card">
            <p className="usage-line">
              Unpair from this computer? You&apos;ll need the QR code to reconnect.
            </p>
            <div className="perm-actions">
              <button className="btn btn-danger" onClick={unpair}>
                Unpair
              </button>
              <button className="btn" onClick={() => setConfirmUnpair(false)}>
                Cancel
              </button>
            </div>
          </section>
        ) : (
          <button className="btn btn-ghost btn-danger" onClick={() => setConfirmUnpair(true)}>
            Unpair from this computer
          </button>
        )}
      </main>
    </div>
  )
}
