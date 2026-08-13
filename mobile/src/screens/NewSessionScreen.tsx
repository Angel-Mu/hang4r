import { useEffect, useState, type JSX } from 'react'
import type { ModelChoice } from '@shared/protocol'
import { CLAUDE_MODELS, CURRENT_CLAUDE_VERSIONS } from '@shared/claudeModels'
import { bridge, useApp } from '../state/store'

const BACKENDS = ['claude', 'codex', 'cursor'] as const
type Backend = (typeof BACKENDS)[number]

const PERMISSION_MODES = [
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'bypassPermissions', label: 'Bypass (YOLO)' }
]

const claudeChoices: ModelChoice[] = CLAUDE_MODELS.map((m) => ({
  ...m,
  label: CURRENT_CLAUDE_VERSIONS[m.value] ?? m.label
}))

export function NewSessionScreen(): JSX.Element {
  const projects = useApp((s) => s.projects)
  const setScreen = useApp((s) => s.setScreen)
  const startSession = useApp((s) => s.startSession)

  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [backend, setBackend] = useState<Backend>('claude')
  const [auth, setAuth] = useState<Record<Backend, string>>({
    claude: 'unknown',
    codex: 'unknown',
    cursor: 'unknown'
  })
  const [models, setModels] = useState<ModelChoice[]>(claudeChoices)
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState('acceptEdits')
  const [environment, setEnvironment] = useState<'worktree' | 'local'>('worktree')
  const [firstPrompt, setFirstPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void bridge()
      .call<Record<Backend, string>>('authStatus')
      .then(setAuth)
      .catch(() => {})
  }, [])

  useEffect(() => {
    setModel('')
    if (backend === 'claude') {
      setModels(claudeChoices)
      return
    }
    setModels([{ value: '', label: 'Default model' }])
    void bridge()
      .call<ModelChoice[]>(backend === 'codex' ? 'listCodexModels' : 'listCursorModels')
      .then((list) => setModels(list.length ? list : [{ value: '', label: 'Default model' }]))
      .catch(() => {})
  }, [backend])

  useEffect(() => {
    void bridge()
      .call<string | null>('resolveAgentDefault', backend, 'permissionMode', projectId || undefined)
      .then((v) => v && setPermissionMode(v))
      .catch(() => {})
  }, [backend, projectId])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await startSession({
        projectId,
        backend,
        environment,
        permissionMode,
        model: model || undefined,
        firstPrompt: firstPrompt.trim() || undefined
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <button className="btn btn-ghost" onClick={() => setScreen('home')}>
          ‹ Back
        </button>
        <span className="topbar-title">New agent</span>
      </header>
      <main className="form-screen">
        <label className="form-label">Workspace</label>
        <select className="form-field" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label className="form-label">Agent</label>
        <div className="segment">
          {BACKENDS.map((b) => (
            <button
              key={b}
              className={'segment-item' + (backend === b ? ' segment-active' : '')}
              disabled={auth[b] === 'out'}
              onClick={() => setBackend(b)}
            >
              {b}
              {auth[b] === 'out' ? ' (logged out)' : ''}
            </button>
          ))}
        </div>

        <label className="form-label">Model</label>
        <select className="form-field" value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <label className="form-label">Permissions</label>
        <select
          className="form-field"
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value)}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <label className="form-label">Environment</label>
        <div className="segment">
          <button
            className={'segment-item' + (environment === 'worktree' ? ' segment-active' : '')}
            onClick={() => setEnvironment('worktree')}
          >
            Worktree
          </button>
          <button
            className={'segment-item' + (environment === 'local' ? ' segment-active' : '')}
            onClick={() => setEnvironment('local')}
          >
            Local
          </button>
        </div>

        <label className="form-label">First prompt (optional)</label>
        <textarea
          className="form-field form-textarea"
          placeholder="What should the agent do?"
          value={firstPrompt}
          onChange={(e) => setFirstPrompt(e.target.value)}
          rows={4}
        />

        {error && <p className="pair-error">{error}</p>}
        <button className="btn btn-primary" disabled={!projectId || busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Start agent'}
        </button>
      </main>
    </div>
  )
}
