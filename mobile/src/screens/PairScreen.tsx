import { useCallback, useState, type JSX } from 'react'
import { useApp } from '../state/store'
import { QrScan } from '../components/QrScan'

export function PairScreen(): JSX.Element {
  const pair = useApp((s) => s.pair)
  const [value, setValue] = useState('')
  const [bad, setBad] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  const submit = (): void => {
    if (!pair(value)) setBad(true)
  }

  const onScanResult = useCallback(
    (raw: string): void => {
      setScanning(false)
      if (!pair(raw)) setScanError("That QR code isn't a hang4r pairing code.")
    },
    [pair]
  )

  if (scanning) return <QrScan onResult={onScanResult} onClose={() => setScanning(false)} />

  return (
    <div className="screen pair-screen">
      <div className="pair-hero">
        <div className="pair-logo">hang4r</div>
        <p className="pair-sub">Your agent sessions, from anywhere.</p>
      </div>
      <div className="pair-form">
        <p className="pair-hint">
          On your computer: <b>hang4r → Settings → Phone → Show pairing QR code</b>.
        </p>
        <button
          className="btn btn-primary"
          onClick={() => {
            setScanError(null)
            setScanning(true)
          }}
        >
          Scan QR code
        </button>
        {scanError && <p className="pair-error">{scanError}</p>}
        <p className="pair-hint">…or copy the pairing link and paste it:</p>
        <textarea
          className="pair-input"
          placeholder="hang4r://pair?…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setBad(false)
          }}
          rows={3}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {bad && <p className="pair-error">That doesn&apos;t look like a hang4r pairing link.</p>}
        <button className="btn btn-primary" disabled={!value.trim()} onClick={submit}>
          Pair with this computer
        </button>
      </div>
    </div>
  )
}
