import { useEffect, useState, type JSX } from 'react'
import type { ModelChoice, SessionMeta } from '@shared/protocol'
import { CLAUDE_MODELS, CURRENT_CLAUDE_VERSIONS } from '@shared/claudeModels'
import { bridge, useApp } from '../state/store'
import type { Transcript } from '../state/transcript'

const PERMISSION_MODES = [
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'YOLO' }
]

const claudeChoices: ModelChoice[] = CLAUDE_MODELS.map((m) => ({
  ...m,
  label: CURRENT_CLAUDE_VERSIONS[m.value] ?? m.label
}))

function needsDesktop(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('unknown method')
    ? 'Needs a newer hang4r on your computer — update it and retry.'
    : msg
}

/** Bottom sheet with the session's live vitals + controls: model, permission
 *  mode, context-window gauge, branch, stop. */
export function SessionInfoSheet({
  session,
  transcript,
  onClose
}: {
  session: SessionMeta
  transcript?: Transcript
  onClose: () => void
}): JSX.Element {
  const refresh = useApp((s) => s.refresh)
  const interrupt = useApp((s) => s.interrupt)
  const [models, setModels] = useState<ModelChoice[]>(claudeChoices)
  const [branch, setBranch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (session.backend === 'claude') {
      setModels(claudeChoices)
    } else {
      void bridge()
        .call<ModelChoice[]>(session.backend === 'codex' ? 'listCodexModels' : 'listCursorModels')
        .then((list) => setModels(list.length ? list : [{ value: '', label: 'Default model' }]))
        .catch(() => {})
    }
    void bridge()
      .call<string | null>('currentBranch', session.id)
      .then(setBranch)
      .catch(() => {})
  }, [session.id, session.backend])

  const setModel = async (model: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await bridge().call('setSessionModel', session.id, model)
      await refresh()
    } catch (e) {
      setError(needsDesktop(e))
    } finally {
      setBusy(false)
    }
  }

  const setMode = async (mode: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await bridge().call('setSessionPermissionMode', session.id, mode)
      await refresh()
    } catch (e) {
      setError(needsDesktop(e))
    } finally {
      setBusy(false)
    }
  }

  const running = session.status === 'running' || session.status === 'starting'
  const ctxPct =
    transcript?.ctxTokens && transcript.ctxWindow
      ? Math.min(100, Math.round((transcript.ctxTokens / transcript.ctxWindow) * 100))
      : null

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet">
        <div className="sheet-grab" />
        <p className="sheet-title">{session.title}</p>
        <p className="usage-line usage-dim">
          {session.backend} · {session.environment}
          {branch ? ` · ${branch}` : ''}
        </p>

        {ctxPct !== null && (
          <div className="usage-window">
            <div className="usage-window-head">
              <span>Context window</span>
              <span>
                {Math.round((transcript!.ctxTokens ?? 0) / 1000)}k /{' '}
                {Math.round((transcript!.ctxWindow ?? 0) / 1000)}k · {ctxPct}%
              </span>
            </div>
            <div className="usage-bar">
              <div
                className={'usage-fill' + (ctxPct >= 85 ? ' usage-hot' : '')}
                style={{ width: `${ctxPct}%` }}
              />
            </div>
          </div>
        )}

        <label className="form-label">Model</label>
        <select
          className="form-field"
          disabled={busy}
          value={session.model ?? ''}
          onChange={(e) => void setModel(e.target.value)}
        >
          {!models.some((m) => m.value === (session.model ?? '')) && (
            <option value={session.model ?? ''}>{session.model ?? 'Default model'}</option>
          )}
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <label className="form-label">Permissions</label>
        <div className="segment">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.value}
              disabled={busy}
              className={
                'segment-item' + (session.permissionMode === m.value ? ' segment-active' : '')
              }
              onClick={() => void setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {error && <p className="pair-error">{error}</p>}
        {running && (
          <button
            className="btn btn-danger"
            onClick={() => {
              void interrupt()
              onClose()
            }}
          >
            Stop this turn
          </button>
        )}
      </div>
    </>
  )
}
