import { useCallback, useEffect, useState, type JSX } from 'react'
import { useHang4r } from '../state/store'
import { Icon } from './Icon'
import { TerminalView } from './TerminalView'

interface Proc {
  name: string
  command: string
  /** start with the agent (Angel's spec: per-process opt-in, OFF by default —
   *  unchecked processes only run via the Start button) */
  autoStart?: boolean
}

/**
 * Per-workspace dev/service processes (Cursor's environment.json idea): declare
 * commands, see their live output + status, start/stop. Config persists per
 * workspace. A process runs at session creation ONLY if its "run on agent
 * start" box is checked (worktree sessions additionally wait for the setup
 * script to finish so nothing launches into an unprovisioned tree).
 */
export function ProcessesPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const projectId = useHang4r((s) => s.sessions.find((x) => x.id === sessionId)?.projectId)
  const [procs, setProcs] = useState<Proc[]>([])
  const [running, setRunning] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Proc[]>([])

  const load = useCallback(() => {
    if (!projectId) return
    void window.hang4r.getSetting(`devProcesses:${projectId}`).then((raw) => {
      try {
        setProcs(raw ? (JSON.parse(raw) as Proc[]) : [])
      } catch {
        setProcs([])
      }
    })
  }, [projectId])
  useEffect(load, [load])

  // reflect processes already started (auto-start on session create)
  useEffect(() => {
    let alive = true
    procs.forEach((_, i) => {
      void window.hang4r.processRunning(`dev:${sessionId}:${i}`).then((on) => {
        if (alive && on) setRunning((s) => new Set(s).add(i))
      })
    })
    return () => {
      alive = false
    }
  }, [procs, sessionId])

  // exit code per process index — a crashed dev server must say WHY it died,
  // not silently flip back to "Start"
  const [exits, setExits] = useState<Record<number, number>>({})

  // flip to stopped when a process exits, keeping the exit code visible
  useEffect(() => {
    return window.hang4r.onTerminalExit((tid, code) => {
      const m = new RegExp(`^dev:${sessionId}:(\\d+)$`).exec(tid)
      if (!m) return
      const i = Number(m[1])
      setRunning((s) => {
        const n = new Set(s)
        n.delete(i)
        return n
      })
      setExits((e) => ({ ...e, [i]: code }))
    })
  }, [sessionId])

  const start = (i: number): void => {
    setExits((e) => {
      const n = { ...e }
      delete n[i]
      return n
    })
    setRunning((s) => new Set(s).add(i))
  }
  const stop = (i: number): void => {
    void window.hang4r.disposeTerminal(`dev:${sessionId}:${i}`)
    setRunning((s) => {
      const n = new Set(s)
      n.delete(i)
      return n
    })
    // user-initiated stop isn't a failure — no exit banner
    setExits((e) => {
      const n = { ...e }
      delete n[i]
      return n
    })
  }

  const exitLabel = (code: number): string => {
    if (code === 127) return `exited · command not found (127)`
    if (code === 126) return `exited · not executable (126)`
    return code === 0 ? 'exited cleanly (0)' : `exited · code ${code}`
  }
  const saveDraft = (): void => {
    if (!projectId) return
    const clean = draft.filter((p) => p.command.trim())
    void window.hang4r.setSetting(`devProcesses:${projectId}`, JSON.stringify(clean))
    setProcs(clean)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="proc-panel">
        <div className="proc-head">
          <span>Configure processes</span>
          <div>
            <button className="ghost-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="primary-btn" onClick={saveDraft}>
              Save
            </button>
          </div>
        </div>
        <div className="proc-edit-list">
          {draft.map((p, i) => (
            <div key={i} className="proc-edit-row">
              <input
                className="field"
                placeholder="name (e.g. web)"
                value={p.name}
                onChange={(e) =>
                  setDraft((d) => d.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
              <input
                className="field proc-cmd"
                placeholder="command (e.g. npm run dev)"
                value={p.command}
                onChange={(e) =>
                  setDraft((d) => d.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))
                }
              />
              <label
                className="proc-autostart"
                title="Start this process automatically with the agent (worktree sessions wait for the setup script first). Unchecked: only the Start button runs it."
              >
                <input
                  type="checkbox"
                  checked={!!p.autoStart}
                  onChange={(e) =>
                    setDraft((d) =>
                      d.map((x, j) => (j === i ? { ...x, autoStart: e.target.checked } : x))
                    )
                  }
                />
                run on agent start
              </label>
              <button
                className="ghost-btn"
                title="Remove"
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="ghost-btn proc-add"
            onClick={() => setDraft((d) => [...d, { name: '', command: '' }])}
          >
            + Add process
          </button>
        </div>
      </div>
    )
  }

  const openEditor = (): void => {
    setDraft(procs.length ? procs : [{ name: '', command: '' }])
    setEditing(true)
  }

  return (
    <div className="proc-panel">
      <div className="proc-head">
        <span>Processes</span>
        {procs.length > 0 && (
          <button className="ghost-btn" onClick={openEditor}>
            <Icon name="settings" size={12} /> Edit processes
          </button>
        )}
      </div>
      {procs.length === 0 && (
        <div className="proc-empty">
          <p className="proc-empty-lead">
            <b>Dev processes</b> are per-workspace commands that run inside each session's own
            working directory, right alongside the agent. By default they only run when you press
            Start here; check <em>run on agent start</em> on a process to launch it with every new
            session (worktree sessions wait for the setup script to finish first).
          </p>
          <p>
            For example, add one named <code>dev</code> running <code>npm run dev</code> to get a live dev
            server in every session here.
          </p>
          <button className="primary-btn proc-empty-add" onClick={openEditor}>
            + Add process
          </button>
          <p className="proc-empty-note">
            Versioned like the rest of your setup — saved under <code>devProcesses</code> in{' '}
            <code>&lt;repo&gt;/.hang4r/settings.json</code>, so teammates get the same commands.
          </p>
        </div>
      )}
      <div className="proc-list">
        {procs.map((p, i) => {
          const id = `dev:${sessionId}:${i}`
          const on = running.has(i)
          return (
            <div key={i} className="proc-item">
              <div className="proc-item-head">
                <span
                  className={
                    'proc-dot ' +
                    (on ? 'proc-on' : exits[i] !== undefined && exits[i] !== 0 ? 'proc-err' : 'proc-off')
                  }
                />
                <span className="proc-name">{p.name || `process ${i + 1}`}</span>
                <code className="proc-cmd-label">{p.command}</code>
                {!on && exits[i] !== undefined && (
                  <span className={'proc-exit' + (exits[i] === 0 ? '' : ' proc-exit-bad')}>
                    {exitLabel(exits[i])}
                  </span>
                )}
                <span className="proc-actions">
                  {on ? (
                    <>
                      <button className="ghost-btn" title="Restart" onClick={() => { stop(i); setTimeout(() => start(i), 60) }}>
                        ↻
                      </button>
                      <button className="ghost-btn proc-stop" title="Stop" onClick={() => stop(i)}>
                        ◼ Stop
                      </button>
                    </>
                  ) : (
                    <button className="ghost-btn proc-start" title="Start" onClick={() => start(i)}>
                      ▶ Start
                    </button>
                  )}
                </span>
              </div>
              {on && (
                <div className="proc-term">
                  <TerminalView sessionId={sessionId} id={id} command={p.command} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
