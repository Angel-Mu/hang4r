import { useEffect, useState, type JSX } from 'react'
import { parsePairingUrl } from '@shared/bridge'
import { bridge, useApp } from '../state/store'
import { useNav } from '../components/PushScreen'

export function SettingsScreen(): JSX.Element {
  const nav = useNav()
  const unpair = useApp((s) => s.unpair)
  const conn = useApp((s) => s.conn)
  const pairingUrl = useApp((s) => s.pairingUrl)
  const pushStatus = useApp((s) => s.pushStatus)
  const textScale = useApp((s) => s.textScale)
  const setTextScale = useApp((s) => s.setTextScale)
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const pushEnabled = useApp((s) => s.pushEnabled)
  const setPushEnabled = useApp((s) => s.setPushEnabled)
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
    <div className="screen">
      <header className="topbar">
        <button className="btn btn-ghost" onClick={nav.back}>
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
          <h2 className="usage-title">Appearance</h2>
          <div className="segment">
            {(['system', 'dark', 'light'] as const).map((t) => (
              <button
                key={t}
                className={'segment-item' + (theme === t ? ' segment-active' : '')}
                onClick={() => setTheme(t)}
              >
                {t === 'system' ? 'System' : t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </section>
        <section className="usage-card">
          <h2 className="usage-title">Notifications</h2>
          <label className="push-toggle">
            <input
              type="checkbox"
              checked={pushEnabled}
              onChange={(e) => setPushEnabled(e.target.checked)}
            />
            Push when an agent finishes or needs approval
          </label>
          <p className="usage-line usage-dim">Status: {pushStatus}</p>
        </section>
        <section className="usage-card">
          <h2 className="usage-title">Text size</h2>
          <div className="segment">
            {(['s', 'm', 'l'] as const).map((t) => (
              <button
                key={t}
                className={'segment-item' + (textScale === t ? ' segment-active' : '')}
                onClick={() => setTextScale(t)}
              >
                {t === 's' ? 'Small' : t === 'm' ? 'Default' : 'Large'}
              </button>
            ))}
          </div>
        </section>
        <section className="usage-card">
          <h2 className="usage-title">This app</h2>
          <p className="usage-line usage-dim">hang4r mobile 0.1.0</p>
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
