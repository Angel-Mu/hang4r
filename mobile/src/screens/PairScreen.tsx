import { useState, type JSX } from 'react'
import { useApp } from '../state/store'

export function PairScreen(): JSX.Element {
  const pair = useApp((s) => s.pair)
  const [value, setValue] = useState('')
  const [bad, setBad] = useState(false)

  const submit = (): void => {
    if (!pair(value)) setBad(true)
  }

  return (
    <div className="screen pair-screen">
      <div className="pair-hero">
        <div className="pair-logo">hang4r</div>
        <p className="pair-sub">Your agent sessions, from anywhere.</p>
      </div>
      <div className="pair-form">
        <p className="pair-hint">
          On your computer: <b>hang4r → Settings → Phone → Show pairing QR code</b>, then copy the
          pairing link and paste it here.
        </p>
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
