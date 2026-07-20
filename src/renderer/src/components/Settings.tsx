import { useEffect, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useHang4r } from '../state/store'
import { THEMES, type Theme } from '../theme'
import type { SettingsScope, UpdateStatus } from '../../../shared/protocol'
import { SettingsJsonEditor } from './SettingsJsonEditor'
import {
  ACTION_LABELS,
  NATURAL_KEYMAP_DEFAULTS,
  chordLabel,
  loadTerminalKeymap,
  type KeyBinding,
  type KeymapAction
} from '../terminalKeymap'

interface SshHost {
  id: string
  label: string
  host: string
  dir: string
}

/**
 * SSH remote hosts (docs/ssh-design.md, v1 slice 1). Hosts resolve through the
 * user's own ~/.ssh/config — aliases, keys, ProxyJump all apply. "Test" checks
 * reachability and that the remote has a logged-in-able `claude` on PATH.
 * Sessions can't run on these hosts yet; this registers + verifies them.
 */
function RemoteHosts(): JSX.Element {
  const [hosts, setHosts] = useState<SshHost[]>([])
  const [label, setLabel] = useState('')
  const [host, setHost] = useState('')
  const [dir, setDir] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})

  useEffect(() => {
    void window.hang4r.getSetting('sshHosts').then((v) => {
      try {
        setHosts(v ? (JSON.parse(v) as SshHost[]) : [])
      } catch {
        setHosts([])
      }
    })
  }, [])

  const persist = (next: SshHost[]): void => {
    setHosts(next)
    void window.hang4r.setSetting('sshHosts', JSON.stringify(next))
  }

  const add = (): void => {
    const h = host.trim()
    if (!h) return
    persist([
      ...hosts,
      { id: crypto.randomUUID(), label: label.trim() || h, host: h, dir: dir.trim() }
    ])
    setLabel('')
    setHost('')
    setDir('')
  }

  const test = async (h: SshHost): Promise<void> => {
    setTesting(h.id)
    setResults((r) => ({ ...r, [h.id]: '' }))
    try {
      const res = await window.hang4r.testRemoteHost(h.host)
      const text = !res.reachable
        ? `✗ unreachable — ${res.error ?? 'unknown error'}`
        : res.claudeVersion
          ? `✓ connected · ${res.claudeVersion}`
          : '✓ connected · claude CLI not found on remote PATH'
      setResults((r) => ({ ...r, [h.id]: text }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <>
      <p className="settings-note">
        <strong>SSH remotes (experimental).</strong> Hosts resolve through your own{' '}
        <code>~/.ssh/config</code> (aliases, keys, ProxyJump). The remote machine needs its own
        logged-in <code>claude</code> CLI — hang4r never copies credentials. Running sessions on
        these hosts lands next; registering + testing hosts works today.
      </p>
      {hosts.map((h) => (
        <div className="remote-host-row" key={h.id}>
          <div className="remote-host-main">
            <span className="remote-host-label">{h.label}</span>
            <span className="remote-host-target">
              {h.host}
              {h.dir ? ` · ${h.dir}` : ''}
            </span>
            {results[h.id] && (
              <span
                className={
                  'remote-host-result' + (results[h.id].startsWith('✓') ? ' ok' : ' bad')
                }
              >
                {results[h.id]}
              </span>
            )}
          </div>
          <button className="ghost-btn" disabled={testing === h.id} onClick={() => void test(h)}>
            {testing === h.id ? 'Testing…' : 'Test'}
          </button>
          <button
            className="ghost-btn"
            title="Remove host"
            onClick={() => persist(hosts.filter((x) => x.id !== h.id))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="remote-host-add">
        <input
          className="field"
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          className="field"
          placeholder="user@host or ssh-config alias"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <input
          className="field"
          placeholder="Default remote dir (e.g. ~/work)"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="primary-btn" disabled={!host.trim()} onClick={add}>
          Add host
        </button>
      </div>
    </>
  )
}

const MODIFIER_KEYS = new Set(['Meta', 'Alt', 'Control', 'Shift'])

/** iTerm2-style key mapping table: keystroke chip (click → record next keydown),
 *  action dropdown (+ text field for 'send-text'), remove. Controlled by the
 *  parent's `keymap` state — persisted on the parent's Save button. */
function KeyBindingsEditor({
  bindings,
  onChange
}: {
  bindings: KeyBinding[]
  onChange: (next: KeyBinding[]) => void
}): JSX.Element {
  const [recording, setRecording] = useState<number | null>(null)

  const updateAt = (i: number, patch: Partial<KeyBinding>): void => {
    onChange(bindings.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))
  }
  const removeAt = (i: number): void => {
    onChange(bindings.filter((_, idx) => idx !== i))
    setRecording((r) => (r === i ? null : r))
  }
  const addBinding = (): void => {
    onChange([
      ...bindings,
      { key: { key: '', meta: false, alt: false, ctrl: false, shift: false }, action: 'word-back' }
    ])
    setRecording(bindings.length)
  }
  const onRecordKeyDown = (i: number, e: ReactKeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (MODIFIER_KEYS.has(e.key)) return
    updateAt(i, { key: { key: e.key, meta: e.metaKey, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey } })
    setRecording(null)
  }

  return (
    <div className="keymap-editor">
      {bindings.map((b, i) => (
        <div className="keymap-row" key={i}>
          <button
            type="button"
            ref={recording === i ? (el) => el?.focus() : undefined}
            className={'keymap-chip' + (recording === i ? ' keymap-chip-recording' : '')}
            onClick={() => setRecording(i)}
            onKeyDown={recording === i ? (e) => onRecordKeyDown(i, e) : undefined}
            onBlur={() => setRecording((r) => (r === i ? null : r))}
          >
            {recording === i ? 'Press keys…' : chordLabel(b.key) || 'Record'}
          </button>
          <select
            className="field"
            value={b.action}
            onChange={(e) => updateAt(i, { action: e.target.value as KeymapAction })}
          >
            {(Object.entries(ACTION_LABELS) as [KeymapAction, string][]).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          {b.action === 'send-text' && (
            <input
              className="field keymap-text"
              placeholder={'\\x1b[A or literal text'}
              value={b.text ?? ''}
              onChange={(e) => updateAt(i, { text: e.target.value })}
            />
          )}
          <button className="ghost-btn" title="Remove binding" onClick={() => removeAt(i)}>
            ✕
          </button>
        </div>
      ))}
      <div className="keymap-actions">
        <button className="ghost-btn" onClick={addBinding}>
          Add binding
        </button>
        <button className="ghost-btn" onClick={() => onChange(NATURAL_KEYMAP_DEFAULTS)}>
          Restore defaults
        </button>
      </div>
    </div>
  )
}

/** Sign-in status for the wrapped CLIs (Claude / Codex). Auth is owned by the
 *  CLIs — we only detect + offer to open their login flow. */
function AuthStatus(): JSX.Element {
  const [status, setStatus] = useState<{ claude: string; codex: string; cursor: string }>({
    claude: 'unknown',
    codex: 'unknown',
    cursor: 'unknown'
  })
  const refresh = (): void => {
    void window.hang4r.authStatus().then(setStatus)
  }
  useEffect(refresh, [])
  const row = (backend: 'claude' | 'codex' | 'cursor', label: string, state: string): JSX.Element => {
    const dot = state === 'in' ? 'auth-in' : state === 'out' ? 'auth-out' : 'auth-unknown'
    const text = state === 'in' ? 'Signed in' : state === 'out' ? 'Not signed in' : 'Unknown'
    return (
      <div className="auth-row">
        <span className={'auth-dot ' + dot} />
        <span className="auth-label">{label}</span>
        <span className="auth-state">{text}</span>
        {state !== 'in' && (
          <button
            className="ghost-btn"
            onClick={() => void window.hang4r.authLogin(backend).then(() => setTimeout(refresh, 1500))}
          >
            Sign in…
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="auth-status">
      {row('claude', 'Claude Code', status.claude)}
      {row('codex', 'Codex', status.codex)}
      {row('cursor', 'Cursor', status.cursor)}
    </div>
  )
}

/** Check for / download / install app updates (electron-updater → GitHub). */
/** version + support links (external links open in the OS browser via the
 *  app's will-navigate guard — never navigate the app window) */
function AboutBlock(): JSX.Element {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.hang4r.appVersion().then(setVersion)
  }, [])
  return (
    <div className="about-block">
      <span className="about-version">hang4r {version || '…'}</span>
      <span className="about-links">
        <a href="https://hang4r.dev">hang4r.dev</a>
        <a href="https://github.com/Angel-Mu/hang4r-releases/issues">Report an issue</a>
        <a href="https://github.com/sponsors/Angel-Mu">Sponsor</a>
        <a href="https://ko-fi.com/angel_xmu">Ko-fi</a>
      </span>
      <p className="settings-note">
        Free for the community — it wraps subscriptions you already pay for. If it saves you
        time, the links above keep it going.
      </p>
    </div>
  )
}

function UpdatesControl(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.hang4r.getUpdateStatus().then(setStatus)
    return window.hang4r.onUpdateStatus(setStatus)
  }, [])

  const label = ((): string => {
    switch (status.state) {
      case 'checking':
        return 'Checking…'
      case 'available':
        return `Update ${status.version} available`
      case 'not-available':
        return "You're up to date"
      case 'downloading':
        return `Downloading… ${status.percent}%`
      case 'downloaded':
        return `Update ${status.version} ready`
      case 'error':
        return status.message
      default:
        return 'Up to date checks run in the packaged app'
    }
  })()

  return (
    <div className="update-control">
      {status.state === 'available' ? (
        <button
          className="primary-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.hang4r.downloadUpdate().finally(() => setBusy(false))
          }}
        >
          Download update
        </button>
      ) : status.state === 'downloaded' ? (
        <button className="primary-btn" onClick={() => void window.hang4r.installUpdate()}>
          Restart &amp; install
        </button>
      ) : (
        <button
          className="ghost-btn"
          disabled={busy || status.state === 'checking'}
          onClick={() => {
            setBusy(true)
            void window.hang4r.checkForUpdates().finally(() => setBusy(false))
          }}
        >
          Check for updates
        </button>
      )}
      <span className={'update-status' + (status.state === 'error' ? ' update-error' : '')}>
        {label}
      </span>
    </div>
  )
}

type Category =
  | 'General'
  | 'Models'
  | 'Agents'
  | 'Worktrees'
  | 'Remote'
  | 'Plugins'
  | 'Rules & Skills'
  | 'Tools & MCPs'
  | 'Hooks'
  | 'Keyboard'
  | 'settings.json'

const CATEGORIES: Category[] = [
  'General',
  'Models',
  'Agents',
  'Worktrees',
  'Remote',
  'Plugins',
  'Rules & Skills',
  'Tools & MCPs',
  'Hooks',
  'Keyboard',
  'settings.json'
]

const SHORTCUTS: [string, string][] = [
  ['⌘K', 'Command palette'],
  ['⌘⇧P', 'Command palette'],
  ['⌘P', 'Quick file finder'],
  ['⌘⇧F', 'Search in files'],
  ['⌘F', 'Find (conversation / file / terminal)'],
  ['⌘N', 'New agent'],
  ['⌘,', 'Settings'],
  ['⌘B', 'Toggle sidebar'],
  ['⌃`', 'Toggle terminal'],
  ['⌥⌘B', 'Toggle panel'],
  ['⌘\\', 'Split editor right'],
  ['⌘1–4', 'Focus pane 1–4'],
  ['⌘⇧E', 'Expand / restore pane'],
  ['⌘W', 'Close (editor / terminal / pane)'],
  ['⌘.', 'Stop agent'],
  ['⌘S', 'Save file (editor)'],
  ['⌘↩', 'Send message (composer)']
]

/** Categorized settings page (Cursor-style left nav). */
export function Settings(): JSX.Element | null {
  const open = useHang4r((s) => s.settingsOpen)
  const close = useHang4r((s) => s.setSettingsOpen)
  const requestedCategory = useHang4r((s) => s.settingsCategory)
  const theme = useHang4r((s) => s.theme)
  const setTheme = useHang4r((s) => s.setTheme)
  const editorFontSize = useHang4r((s) => s.editorFontSize)
  const setEditorFontSize = useHang4r((s) => s.setEditorFontSize)
  const chatFontSize = useHang4r((s) => s.chatFontSize)
  const setChatFontSize = useHang4r((s) => s.setChatFontSize)
  const sessionInits = useHang4r((s) => s.sessionInit)
  const openSessionCount = Object.keys(sessionInits).length

  const [cat, setCat] = useState<Category>('General')
  // raw settings.json editor scope: '' = app file, else a projectId (workspace)
  const [jsonScopeId, setJsonScopeId] = useState('')

  // Esc closes the modal (matches every other overlay)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])
  const [claudePath, setClaudePath] = useState('')
  const [codexPath, setCodexPath] = useState('')
  const [cursorPath, setCursorPath] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [defaultPerm, setDefaultPerm] = useState('acceptEdits')
  const [defaultEnv, setDefaultEnv] = useState('worktree')
  const [worktreeDir, setWorktreeDir] = useState('')
  const [branchPrefix, setBranchPrefix] = useState('')
  const [setupScript, setSetupScript] = useState('')
  const [wtScope, setWtScope] = useState('') // '' = global default, else projectId
  const [terminalShell, setTerminalShell] = useState('')
  const [notifyOnComplete, setNotifyOnComplete] = useState(true)
  const [notifyOnActionRequired, setNotifyOnActionRequired] = useState(true)
  const [notifyOnError, setNotifyOnError] = useState(true)
  const [keymap, setKeymap] = useState<KeyBinding[]>(NATURAL_KEYMAP_DEFAULTS)
  const [saved, setSaved] = useState(false)
  const projects = useHang4r((s) => s.projects)

  useEffect(() => {
    if (!open) return
    setSaved(false)
    // a command-palette entry can request a specific category on open
    if (requestedCategory && CATEGORIES.includes(requestedCategory as Category)) {
      setCat(requestedCategory as Category)
    }
    void window.hang4r.getSetting('claudeBinaryPath').then((v) => setClaudePath(v ?? ''))
    void window.hang4r.getSetting('codexBinaryPath').then((v) => setCodexPath(v ?? ''))
    void window.hang4r.getSetting('cursorBinaryPath').then((v) => setCursorPath(v ?? ''))
    void window.hang4r.getSetting('defaultModel').then((v) => setDefaultModel(v ?? ''))
    void window.hang4r.getSetting('defaultPermissionMode').then((v) => setDefaultPerm(v ?? 'acceptEdits'))
    void window.hang4r.getSetting('defaultEnvironment').then((v) => setDefaultEnv(v ?? 'worktree'))
    void window.hang4r.getSetting('terminalShell').then((v) => setTerminalShell(v ?? ''))
    void window.hang4r.getSetting('notifyOnComplete').then((v) => setNotifyOnComplete(v !== 'off'))
    void window.hang4r
      .getSetting('notifications.onActionRequired')
      .then((v) => setNotifyOnActionRequired(v !== 'off'))
    void window.hang4r.getSetting('notifications.onError').then((v) => setNotifyOnError(v !== 'off'))
    void loadTerminalKeymap().then(setKeymap)
  }, [open, requestedCategory])

  // worktree config is per-workspace: reload the fields when the scope changes
  useEffect(() => {
    if (!open) return
    const suffix = wtScope ? `:${wtScope}` : ''
    void window.hang4r.getSetting(`worktreeDir${suffix}`).then((v) => setWorktreeDir(v ?? ''))
    void window.hang4r
      .getSetting(`worktreeBranchPrefix${suffix}`)
      .then((v) => setBranchPrefix(v ?? ''))
    void window.hang4r.getSetting(`setupScript${suffix}`).then((v) => setSetupScript(v ?? ''))
  }, [open, wtScope])

  if (!open) return null

  const save = async (): Promise<void> => {
    await window.hang4r.setSetting('claudeBinaryPath', claudePath.trim())
    await window.hang4r.setSetting('codexBinaryPath', codexPath.trim())
    await window.hang4r.setSetting('cursorBinaryPath', cursorPath.trim())
    await window.hang4r.setSetting('defaultModel', defaultModel)
    await window.hang4r.setSetting('defaultPermissionMode', defaultPerm)
    await window.hang4r.setSetting('defaultEnvironment', defaultEnv)
    await window.hang4r.setSetting('terminalShell', terminalShell.trim())
    await window.hang4r.setSetting('notifyOnComplete', notifyOnComplete ? 'on' : 'off')
    await window.hang4r.setSetting(
      'notifications.onActionRequired',
      notifyOnActionRequired ? 'on' : 'off'
    )
    await window.hang4r.setSetting('notifications.onError', notifyOnError ? 'on' : 'off')
    await window.hang4r.setSetting('terminalKeymap', JSON.stringify(keymap))
    // save worktree config under the selected scope (per-workspace or global)
    const suffix = wtScope ? `:${wtScope}` : ''
    await window.hang4r.setSetting(`worktreeDir${suffix}`, worktreeDir.trim())
    await window.hang4r.setSetting(`worktreeBranchPrefix${suffix}`, branchPrefix.trim())
    await window.hang4r.setSetting(`setupScript${suffix}`, setupScript)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className={'settings-page' + (cat === 'settings.json' ? ' settings-page--wide' : '')}>
        <nav className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className={'settings-nav-item' + (c === cat ? ' settings-nav-item-active' : '')}
              onClick={() => setCat(c)}
            >
              {c}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          <div className="settings-header">
            <h2>{cat}</h2>
            <button className="ghost-btn" onClick={() => close(false)}>
              ✕
            </button>
          </div>

          <div
            className={
              'settings-content' + (cat === 'settings.json' ? ' settings-content--fill' : '')
            }
          >
            {cat === 'General' && (
              <>
                <Field label="Theme">
                  <select
                    className="field"
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as Theme)}
                  >
                    {THEMES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Editor font size">
                  <div className="font-size-row">
                    <button className="ghost-btn" onClick={() => setEditorFontSize(editorFontSize - 1)}>−</button>
                    <span className="font-size-value">{editorFontSize}px</span>
                    <button className="ghost-btn" onClick={() => setEditorFontSize(editorFontSize + 1)}>+</button>
                  </div>
                </Field>
                <Field label="Chat font size">
                  <div className="font-size-row">
                    <button className="ghost-btn" onClick={() => setChatFontSize(chatFontSize - 1)}>−</button>
                    <span className="font-size-value">{chatFontSize}px</span>
                    <button className="ghost-btn" onClick={() => setChatFontSize(chatFontSize + 1)}>+</button>
                  </div>
                </Field>
                <Field label="Default permissions">
                  <select className="field" value={defaultPerm} onChange={(e) => setDefaultPerm(e.target.value)}>
                    <option value="acceptEdits">Accept edits</option>
                    <option value="default">Default</option>
                    <option value="plan">Plan mode</option>
                    <option value="bypassPermissions">Bypass (YOLO)</option>
                  </select>
                </Field>
                <Field label="Terminal shell">
                  <input
                    className="field"
                    placeholder="Auto-detected (e.g. /opt/homebrew/bin/fish)"
                    value={terminalShell}
                    onChange={(e) => setTerminalShell(e.target.value)}
                  />
                </Field>
                <Field label="Notifications">
                  <>
                    <div className="notify-option">
                      <label className="notify-toggle">
                        <input
                          type="checkbox"
                          checked={notifyOnComplete}
                          onChange={(e) => setNotifyOnComplete(e.target.checked)}
                        />
                        Notify when an agent finishes while hang4r is in the background
                      </label>
                      <p className="notify-hint">Also adds a dock badge; clicking it focuses the session.</p>
                    </div>
                    <div className="notify-option">
                      <label className="notify-toggle">
                        <input
                          type="checkbox"
                          checked={notifyOnActionRequired}
                          onChange={(e) => setNotifyOnActionRequired(e.target.checked)}
                        />
                        Notify when a session needs your approval
                      </label>
                    </div>
                    <div className="notify-option">
                      <label className="notify-toggle">
                        <input
                          type="checkbox"
                          checked={notifyOnError}
                          onChange={(e) => setNotifyOnError(e.target.checked)}
                        />
                        Notify when a turn ends in error
                      </label>
                    </div>
                    <p className="settings-note-inline settings-note-block">
                      These can be muted per-workspace by hand-editing that project&apos;s{' '}
                      <code>.hang4r/settings.json</code>.
                    </p>
                  </>
                </Field>
                <Field label="Updates">
                  <>
                    <UpdatesControl />
                    <p className="settings-note">
                      hang4r checks for updates on launch and downloads them in the background — no
                      reinstall. When one is ready, a “Restart to update” pill appears up in the
                      title bar; it also installs automatically the next time you quit. Nothing ever
                      closes your app on its own.
                    </p>
                  </>
                </Field>
                <Field label="About">
                  <AboutBlock />
                </Field>
              </>
            )}

            {cat === 'Models' && (
              <>
                <Field label="Sign-in">
                  <AuthStatus />
                </Field>
                <Field label="Default model">
                  <input className="field" placeholder="e.g. opus, sonnet, haiku" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} />
                </Field>
                <Field label="Claude Code binary path">
                  <input className="field" placeholder="auto-detected (PATH / nvm / homebrew)" value={claudePath} onChange={(e) => setClaudePath(e.target.value)} />
                </Field>
                <Field label="Codex binary path">
                  <input className="field" placeholder="auto-detected — needs `codex login`" value={codexPath} onChange={(e) => setCodexPath(e.target.value)} />
                </Field>
                <Field label="Cursor binary path">
                  <input className="field" placeholder="auto-detected — needs `cursor-agent login`" value={cursorPath} onChange={(e) => setCursorPath(e.target.value)} />
                </Field>
              </>
            )}

            {cat === 'Agents' && (
              <Field label="Default environment">
                <select className="field" value={defaultEnv} onChange={(e) => setDefaultEnv(e.target.value)}>
                  <option value="worktree">Git worktree (isolated)</option>
                  <option value="local">In-place</option>
                </select>
              </Field>
            )}

            {cat === 'Remote' && <RemoteHosts />}

            {cat === 'Worktrees' && (
              <>
                <Field label="Configure for">
                  <select className="field" value={wtScope} onChange={(e) => setWtScope(e.target.value)}>
                    <option value="">Global default (all workspaces)</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="settings-note">
                  Worktree config is <strong>per-workspace</strong> — each repo can have its own folder
                  and setup script. A workspace falls back to the global default when left blank.
                </p>
                <Field label="Worktree folder">
                  <input
                    className="field"
                    placeholder={wtScope ? 'inherit global (.hang4r-worktrees)' : '.hang4r-worktrees'}
                    value={worktreeDir}
                    onChange={(e) => setWorktreeDir(e.target.value)}
                  />
                </Field>
                <p className="settings-note">
                  Worktree sessions run in <code>&lt;project&gt;/{worktreeDir.trim() || '.hang4r-worktrees'}/&lt;name&gt;</code> on a
                  branch of the same name — the session title, verbatim. Recreated automatically if
                  removed, cleaned up on archive.
                </p>
                <Field label="Branch prefix">
                  <input
                    className="field"
                    placeholder={wtScope ? 'inherit global (none)' : 'none — e.g. agents/'}
                    value={branchPrefix}
                    onChange={(e) => setBranchPrefix(e.target.value)}
                  />
                </Field>
                <p className="settings-note">
                  Optional namespace for worktree <em>branches</em> (e.g. <code>agents/</code> →{' '}
                  <code>agents/&lt;name&gt;</code>). Off by default: the branch is exactly the name you
                  gave the session.
                </p>
                <Field label="Setup script">
                  <textarea
                    className="field settings-textarea"
                    placeholder={'npm install\n# runs once in each new worktree; $ROOT_WORKTREE_PATH = main repo'}
                    rows={4}
                    value={setupScript}
                    onChange={(e) => setSetupScript(e.target.value)}
                  />
                </Field>
                <p className="settings-note">
                  Runs once in each freshly-created worktree, via your login shell (so{' '}
                  <code>npm</code>/nvm/homebrew resolve like in your terminal) — install deps, copy env
                  files, etc. The session starts immediately and holds its first prompt until setup
                  finishes; progress and failures appear in the session&apos;s chat.{' '}
                  <code>ROOT_WORKTREE_PATH</code> points at the main repo.
                </p>
              </>
            )}

            {cat === 'Plugins' && (
              <LoadedSection
                title="Loaded plugins"
                items={aggregate(sessionInits, (i) => i.plugins.map((p) => p.name))}
                sessionCount={openSessionCount}
                empty="No plugins loaded in any open session."
                source={
                  <>
                    Plugins are loaded by the Claude Code CLI from your{' '}
                    <code>~/.claude</code> and each project&apos;s <code>.claude</code> config. hang4r
                    surfaces what each session reports — it doesn&apos;t install or manage them.
                  </>
                }
              />
            )}
            {cat === 'Rules & Skills' && (
              <>
                <LoadedSection
                  title="Loaded skills"
                  items={aggregate(sessionInits, (i) => i.skills)}
                  sessionCount={openSessionCount}
                  empty="No skills loaded in any open session."
                  source={
                    <>
                      Skills come from <code>~/.claude/skills</code> and per-project{' '}
                      <code>.claude/skills</code>, discovered by the CLI at session start. hang4r
                      lists them; it doesn&apos;t author or edit them.
                    </>
                  }
                />
                <LoadedSection
                  title="Slash commands"
                  items={aggregate(sessionInits, (i) => i.slashCommands)}
                  sessionCount={openSessionCount}
                  empty="No slash commands loaded in any open session."
                  source={
                    <>
                      Custom slash commands live in your CLI config; built-ins ship with the CLI.
                      Permission <strong>rules</strong> for a running session are shown in that
                      session&apos;s Environment panel.
                    </>
                  }
                />
              </>
            )}
            {cat === 'Tools & MCPs' && (
              <>
                <LoadedSection
                  title="Tools"
                  items={aggregate(sessionInits, (i) => i.tools)}
                  sessionCount={openSessionCount}
                  empty="No tools loaded in any open session."
                  source="The tool set is negotiated by the CLI at session start (built-ins plus anything MCP servers contribute)."
                />
                <LoadedSection
                  title="MCP servers"
                  items={aggregate(sessionInits, (i) =>
                    i.mcpServers.map((m) => `${m.name} · ${m.status}`)
                  )}
                  sessionCount={openSessionCount}
                  empty="No MCP servers loaded in any open session."
                  source={
                    <>
                      MCP servers are configured in <code>.mcp.json</code> and your CLI config, then
                      launched by the CLI. hang4r reports their connection status; it doesn&apos;t
                      start or configure them.
                    </>
                  }
                />
              </>
            )}
            {cat === 'Hooks' && (
              <div className="settings-field">
                <label className="field-label">Hooks</label>
                <p className="settings-note">
                  Hooks are configured in your Claude Code settings (<code>~/.claude/settings.json</code>
                  {' '}and per-project overrides) and fire around tool calls and lifecycle events. hang4r
                  doesn&apos;t define or edit hooks — each hook execution is shown inline in the
                  conversation where it ran, and a session&apos;s hook activity is collected in its
                  Hooks timeline.
                </p>
                {openSessionCount === 0 && (
                  <p className="settings-note">Start or open a session to see hook activity.</p>
                )}
              </div>
            )}

            {cat === 'Keyboard' && (
              <>
                <div className="shortcut-grid">
                  {SHORTCUTS.map(([k, desc]) => (
                    <div key={k} className="shortcut-row">
                      <kbd className="kbd">{k}</kbd>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
                <Field label="Terminal key bindings">
                  <>
                    <p className="settings-note-inline settings-note-block">
                      iTerm2-style key mappings — remap mac word/line editing keys or send a
                      custom escape sequence. Applies to new terminals.
                    </p>
                    <KeyBindingsEditor bindings={keymap} onChange={setKeymap} />
                  </>
                </Field>
              </>
            )}

            {cat === 'settings.json' && (
              <>
                <p className="settings-note">
                  Edit the file-backed config directly. The <strong>app</strong> file
                  (<code>~/.hang4r/settings.json</code>) holds global settings; each{' '}
                  <strong>workspace</strong> keeps versionable overrides in
                  <code>&lt;project&gt;/.hang4r/settings.json</code>. Precedence is workspace →
                  app → built-in defaults. External edits reload live.
                </p>
                <Field label="File">
                  <select
                    className="field"
                    value={jsonScopeId}
                    onChange={(e) => setJsonScopeId(e.target.value)}
                  >
                    <option value="">App settings (~/.hang4r/settings.json)</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} (workspace)
                      </option>
                    ))}
                  </select>
                </Field>
                <SettingsJsonEditor
                  key={jsonScopeId || 'app'}
                  scope={(jsonScopeId ? 'workspace' : 'app') as SettingsScope}
                  projectId={jsonScopeId || undefined}
                />
              </>
            )}
          </div>

          <div className="settings-footer">
            {saved && <span className="settings-saved">Saved ✓</span>}
            <button className="primary-btn" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="settings-field">
      <label className="field-label">{label}</label>
      {children}
    </div>
  )
}

interface AggItem {
  name: string
  /** how many open sessions loaded this item */
  count: number
}

type SessionInits = ReturnType<typeof useHang4r.getState>['sessionInit']

/** Union a field across every open session, counting how many loaded each item. */
function aggregate(inits: SessionInits, pick: (init: SessionInits[string]) => string[]): AggItem[] {
  const counts = new Map<string, number>()
  for (const init of Object.values(inits)) {
    for (const name of new Set(pick(init))) {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** One "loaded capabilities" section: aggregated chips + an always-honest note
 *  about where the items come from and that hang4r surfaces (not manages) them. */
function LoadedSection({
  title,
  items,
  sessionCount,
  empty,
  source
}: {
  title: string
  items: AggItem[]
  sessionCount: number
  empty: string
  source: JSX.Element | string
}): JSX.Element {
  return (
    <div className="settings-field">
      <label className="field-label">
        {title}
        {sessionCount > 1 && items.length > 0 && (
          <span className="loaded-count"> · across {sessionCount} open sessions</span>
        )}
      </label>
      {items.length > 0 ? (
        <div className="loaded-list">
          {items.map((it) => (
            <span key={it.name} className="loaded-chip">
              {it.name}
              {sessionCount > 1 && <span className="loaded-chip-count">×{it.count}</span>}
            </span>
          ))}
        </div>
      ) : (
        <p className="settings-note">{empty}</p>
      )}
      <p className="settings-note loaded-source">{source}</p>
    </div>
  )
}
