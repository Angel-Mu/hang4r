import { useEffect, useRef, useState, type JSX } from 'react'
import type { BackendId, EnvironmentKind, ModelChoice, PermissionMode } from '../../../shared/protocol'
import { CLAUDE_MODELS, FALLBACK_CODEX_MODELS, FALLBACK_CURSOR_MODELS } from '../modelChoices'
import { useHang4r } from '../state/store'
import { Icon, type IconName } from './Icon'

const claudeVariants = CLAUDE_MODELS.filter((m) => m.value !== '').map((m) => ({
  backend: 'claude' as const,
  model: m.value,
  label: `Claude ${m.label.replace(/^Claude /, '')}`
}))

// Per-backend identity glyph (glyphs live in Icon.tsx, tinted by CSS)
const BACKEND_ICON: Record<BackendId, IconName> = { claude: 'claude', codex: 'codex', cursor: 'cursor' }

const PERMISSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: 'acceptEdits', label: 'Accept edits (auto-approve file changes)' },
  { value: 'default', label: 'Default (tools may be denied)' },
  { value: 'plan', label: 'Plan mode' },
  { value: 'bypassPermissions', label: 'Bypass permissions (YOLO)' }
]

export function NewSessionDialog(): JSX.Element | null {
  const storeProjectId = useHang4r((s) => s.newSessionProjectId)
  const projects = useHang4r((s) => s.projects)
  const close = useHang4r((s) => s.closeNewSessionDialog)
  const createSession = useHang4r((s) => s.createSession)
  const createBestOfN = useHang4r((s) => s.createBestOfN)

  // the workspace is selectable in-dialog (defaults to whatever opened it)
  const [projectId, setProjectId] = useState<string | null>(storeProjectId)
  // backend/model/environment/permission are declared up top (ahead of the
  // resolution effects below, which read and set them) — everything content-
  // related (prompt, name, best-of-N…) stays declared further down.
  const [backend, setBackend] = useState<BackendId>('claude')
  const [model, setModel] = useState('')
  const [environment, setEnvironment] = useState<EnvironmentKind>('worktree')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('acceptEdits')
  // dirty flags: once the user manually touches a field within an open, later
  // backend/workspace switches must not stomp their explicit choice. Refs (not
  // state) since they only ever gate an async apply, never drive a render.
  const envTouched = useRef(false)
  const permTouched = useRef(false)
  const modelTouched = useRef(false)

  // Resolution order — env: defaultEnvironment → 'worktree'; permission mode:
  // agents.<backend>.permissionMode → defaultPermissionMode → 'acceptEdits';
  // model: agents.<backend>.model → (claude only) defaultModel → '' (built-in
  // default). Workspace agents.* beats app agents.* inside resolveAgentDefault
  // itself. Skips any field the user has already touched this open.
  const applyDefaults = async (be: BackendId, pid: string): Promise<void> => {
    const [envDefault, permAgent, permDefault, modelAgent, modelDefault] = await Promise.all([
      window.hang4r.getSetting('defaultEnvironment'),
      window.hang4r.resolveAgentDefault(be, 'permissionMode', pid),
      window.hang4r.getSetting('defaultPermissionMode'),
      window.hang4r.resolveAgentDefault(be, 'model', pid),
      be === 'claude' ? window.hang4r.getSetting('defaultModel') : Promise.resolve(null)
    ])
    if (!envTouched.current) {
      setEnvironment(((envDefault as EnvironmentKind | null) || 'worktree'))
    }
    if (!permTouched.current) {
      setPermissionMode(((permAgent || permDefault || 'acceptEdits') as PermissionMode))
    }
    if (!modelTouched.current) {
      setModel(modelAgent || modelDefault || '')
    }
  }

  useEffect(() => {
    setProjectId(storeProjectId)
    // the dialog stays mounted while closed (returns null), so each OPEN must
    // start clean — stale best-of-N variants or a leftover prompt from a
    // cancelled open otherwise carry into the next launch. Backend stays
    // sticky on purpose (it's a preference, not content); model/environment/
    // permission are re-resolved from settings on every open below.
    if (storeProjectId) {
      setPrompt('')
      setName('')
      setError(null)
      setBestOfN(false)
      setVariants(new Set())
      envTouched.current = false
      permTouched.current = false
      modelTouched.current = false
      void applyDefaults(backend, storeProjectId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeProjectId])
  const project = projects.find((p) => p.id === projectId)

  // Esc closes the dialog (matches every other overlay)
  useEffect(() => {
    if (!storeProjectId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [storeProjectId, close])

  const [codexModels, setCodexModels] = useState<ModelChoice[]>(FALLBACK_CODEX_MODELS)
  const [cursorModels, setCursorModels] = useState<ModelChoice[]>(FALLBACK_CURSOR_MODELS)
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [bestOfN, setBestOfN] = useState(false)
  const [variants, setVariants] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // SSH hosts from Settings → Remote; the SSH environment only shows when ≥1
  const [sshHosts, setSshHosts] = useState<{ id: string; label: string; host: string; dir: string }[]>([])
  const [remoteHostId, setRemoteHostId] = useState('')
  const [remoteDir, setRemoteDir] = useState('')
  useEffect(() => {
    void window.hang4r.getSetting('sshHosts').then((v) => {
      try {
        setSshHosts(v ? JSON.parse(v) : [])
      } catch {
        setSshHosts([])
      }
    })
  }, [storeProjectId])
  const selectedHost = sshHosts.find((h) => h.id === remoteHostId) ?? sshHosts[0]
  useEffect(() => {
    if (!storeProjectId) return
    void window.hang4r.listCodexModels().then(setCodexModels).catch(() => setCodexModels(FALLBACK_CODEX_MODELS))
    void window.hang4r.listCursorModels().then(setCursorModels).catch(() => setCursorModels(FALLBACK_CURSOR_MODELS))
  }, [storeProjectId])
  // ssh is claude-only (design v1) — switching backend falls back cleanly
  useEffect(() => {
    if (backend !== 'claude' && environment === 'ssh') setEnvironment('worktree')
  }, [backend, environment])

  // switching backend or workspace mid-dialog re-resolves model + permission
  // (a different backend has different agents.* defaults; a different
  // workspace may have its own override file) — applyDefaults itself skips
  // any field the user already touched this open, so an explicit choice
  // survives the switch.
  useEffect(() => {
    if (!storeProjectId || !projectId) return
    void applyDefaults(backend, projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, projectId])

  if (!storeProjectId || !projectId || !project) return null

  const models =
    backend === 'codex' ? codexModels : backend === 'cursor' ? cursorModels : CLAUDE_MODELS
  // A model value is backend-specific. A sticky choice made on another backend
  // (e.g. Claude 'sonnet') is kept in state so it re-appears when you switch
  // back, but it must NOT bleed into the current backend: the native <select>
  // silently coerces an unmatched value to its first option ("Default model"),
  // yet submit used the raw state value — so the dropdown showed "Default
  // model" while the session was actually created with the foreign model (QA
  // #13). Resolve to the backend's Default whenever the stored value isn't a
  // real option here, and use THIS for both the shown value and the submit.
  const effectiveModel = models.some((m) => m.value === model) ? model : ''
  // best-of-N fans out Claude/Codex variants only (Cursor isn't offered here)
  const variantChoices: { backend: 'claude' | 'codex'; model?: string; label: string }[] = [
    { backend: 'claude', label: 'Claude default' },
    ...claudeVariants,
    { backend: 'codex', label: 'Codex default' },
    ...codexModels
      .filter((m) => m.value !== '')
      .map((m) => ({ backend: 'codex' as const, model: m.value, label: m.label }))
  ]

  const toggleVariant = (i: number): void => {
    setVariants((v) => {
      const next = new Set(v)
      if (next.has(i)) {
        next.delete(i)
      } else if (next.size < 4) {
        next.add(i)
      }
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    if (bestOfN) {
      // best-of-N always needs a shared task to fan out across the variants
      if (!prompt.trim()) {
        setError('Best-of-N needs a prompt to run across the variants.')
        return
      }
      if (variants.size < 2) {
        setError('Pick at least 2 variants for best-of-N.')
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      if (bestOfN) {
        await createBestOfN(
          projectId,
          [...variants].map((i) => ({
            backend: variantChoices[i].backend,
            model: variantChoices[i].model
          })),
          permissionMode,
          prompt.trim()
        )
      } else {
        await createSession({
          projectId,
          backend,
          environment,
          model: effectiveModel || undefined,
          permissionMode,
          title: name.trim() || undefined,
          // empty prompt is legal: the session is created idle (worktree +
          // adapter ready), no first turn — start now, prompt from the tile
          firstPrompt: prompt.trim() || undefined,
          ...(environment === 'ssh'
            ? {
                remoteHostId: selectedHost?.id,
                remoteDir: remoteDir.trim() || selectedHost?.dir || ''
              }
            : {})
        })
      }
      setPrompt('')
      setName('')
    } catch (err) {
      // strip Electron's IPC wrapper so the user sees the actual reason
      const msg = (err instanceof Error ? err.message : String(err)).replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        ''
      )
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog">
        <h2 className="dialog-title">New agent session</h2>

        <label className="field-label">Workspace</label>
        <select
          className="field"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label className="field-label">Mode</label>
        <div className="segmented">
          <button className={!bestOfN ? 'segmented-active' : ''} onClick={() => setBestOfN(false)}>
            Single agent
          </button>
          <button
            className={bestOfN ? 'segmented-active' : ''}
            title="Same task across multiple models, each in its own worktree"
            onClick={() => setBestOfN(true)}
          >
            Best of N
          </button>
        </div>

        {bestOfN && (
          <>
            <label className="field-label">Variants (2–4)</label>
            <div className="variant-grid">
              {variantChoices.map((v, i) => (
                <button
                  key={v.label}
                  className={'variant-chip' + (variants.has(i) ? ' variant-chip-active' : '')}
                  onClick={() => toggleVariant(i)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </>
        )}

        {!bestOfN && (
          <>
        <label className="field-label">Agent</label>
        <div className="segmented">
          <button
            className={backend === 'claude' ? 'segmented-active' : ''}
            onClick={() => setBackend('claude')}
          >
            <Icon name={BACKEND_ICON.claude} size={13} className="segmented-glyph" />
            Claude Code
          </button>
          <button
            className={backend === 'codex' ? 'segmented-active' : ''}
            onClick={() => setBackend('codex')}
          >
            <Icon name={BACKEND_ICON.codex} size={13} className="segmented-glyph" />
            Codex
          </button>
          <button
            className={backend === 'cursor' ? 'segmented-active' : ''}
            onClick={() => setBackend('cursor')}
          >
            <Icon name={BACKEND_ICON.cursor} size={13} className="segmented-glyph" />
            Cursor
          </button>
        </div>

        <label className="field-label">Environment</label>
        <div className="segmented">
          <button
            className={environment === 'worktree' ? 'segmented-active' : ''}
            onClick={() => {
              envTouched.current = true
              setEnvironment('worktree')
            }}
          >
            Git worktree (isolated)
          </button>
          <button
            className={environment === 'local' ? 'segmented-active' : ''}
            onClick={() => {
              envTouched.current = true
              setEnvironment('local')
            }}
          >
            In-place
          </button>
          {sshHosts.length > 0 && backend === 'claude' && (
            <button
              className={environment === 'ssh' ? 'segmented-active' : ''}
              title="Run the agent on a remote host (experimental) — configure hosts in Settings → Remote"
              onClick={() => {
                envTouched.current = true
                setEnvironment('ssh')
              }}
            >
              SSH remote
            </button>
          )}
        </div>

        {environment === 'ssh' && (
          <>
            <label className="field-label">Remote host</label>
            <select
              className="field"
              value={selectedHost?.id ?? ''}
              onChange={(e) => setRemoteHostId(e.target.value)}
            >
              {sshHosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label} ({h.host})
                </option>
              ))}
            </select>
            <label className="field-label">Remote directory</label>
            <input
              className="field"
              placeholder={selectedHost?.dir || '~/project'}
              value={remoteDir}
              onChange={(e) => setRemoteDir(e.target.value)}
            />
            <p className="settings-note">
              Chat + terminal run on the remote. Files, diff and git panels don’t follow yet —
              next slice. The remote needs its own logged-in <code>claude</code>.
            </p>
          </>
        )}

        {environment === 'worktree' && (
          <>
            <label className="field-label">Worktree name (optional)</label>
            <input
              className="field"
              placeholder="Optional name — defaults to the prompt"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </>
        )}

        <label className="field-label">Model</label>
        <div className="field-model-row">
          <Icon name={BACKEND_ICON[backend]} size={15} className="field-model-glyph" />
          <select
            className="field"
            value={effectiveModel}
            onChange={(e) => {
              modelTouched.current = true
              setModel(e.target.value)
            }}
          >
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {backend === 'codex' && (
          <div className="dialog-note">
            Codex runs via its native <code>codex app-server</code> protocol. Requires the{' '}
            <code>codex</code> CLI installed and logged in (<code>codex login</code>).
          </div>
        )}

        {backend === 'cursor' && (
          <div className="dialog-note">
            Cursor runs the headless <code>cursor-agent</code> CLI. Requires it installed and logged
            in (<code>cursor-agent login</code>). Permission prompts are flag-based — in Default
            mode risky commands are blocked by Cursor’s policy; use Bypass to run everything.
          </div>
        )}
          </>
        )}

        <label className="field-label">Permissions</label>
        <select
          className="field"
          value={permissionMode}
          onChange={(e) => {
            permTouched.current = true
            setPermissionMode(e.target.value as PermissionMode)
          }}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <label className="field-label">First prompt (optional)</label>
        <textarea
          className="field dialog-prompt"
          autoFocus
          placeholder="What should the agent do?  (leave empty to just start the session)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
        />

        {error && <div className="dialog-error">{error}</div>}

        <div className="dialog-actions">
          <button className="ghost-btn" onClick={close}>
            Cancel
          </button>
          <button className="primary-btn" disabled={busy} onClick={submit}>
            {busy ? 'Starting…' : 'Start agent  ⌘⏎'}
          </button>
        </div>
      </div>
    </div>
  )
}
