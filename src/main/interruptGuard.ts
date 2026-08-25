import { BrowserWindow } from 'electron'
import type { LiveWorkItem } from '../shared/protocol'

/**
 * The confirm shown before anything that cuts live work short. `before-quit`
 * used to own this outright, which left the auto-update restart —
 * `autoUpdater.quitAndInstall()`, which never routes through `app.quit()` —
 * tearing the app down mid-turn with no prompt at all.
 */
export type InterruptKind = 'quit' | 'update'

export interface LiveWork {
  message: string
  detail: string
  /** the same work, itemised — the dialog offers a Stop per row so a stuck turn
   *  can be cleared without cancelling, hunting it down, and quitting again */
  items: LiveWorkItem[]
}

interface Sources {
  /** working agents; a live subagent shows up here, since subagents run
   *  in-process and keep their session 'running' */
  runningAgents: () => LiveWorkItem[]
  /** terminals with a real foreground process — idle shells don't count */
  busyProcesses: () => LiveWorkItem[]
  /** commands whose pty leader exited but whose process group is still alive */
  detachedProcesses: () => LiveWorkItem[]
  /** run_in_background Bash tasks still writing — these outlive their turn, so
   *  their session is usually idle by the time you quit */
  backgroundTasks: () => Promise<LiveWorkItem[]>
}

/** how long the background-task probe may delay a quit before we let it go */
const PROBE_TIMEOUT_MS = 2000

let sources: Sources | null = null
let pending: ((ok: boolean) => void) | null = null

/** Automated runs (e2e/probes) must proceed unattended — a modal confirm would
 *  wedge app.close() until a human clicks it. HANG4R_TEST_QUIT_GUARD opts a
 *  test back in. */
export function guardActive(): boolean {
  return process.env.HANG4R_QUIET_TEST !== '1' || process.env.HANG4R_TEST_QUIT_GUARD === '1'
}

export function initInterruptGuard(s: Sources): void {
  sources = s
}

/**
 * What an abrupt shutdown would interrupt, phrased for the dialog — null when
 * nothing is live and the caller may proceed without asking. A live subagent
 * needs no term of its own: subagents run in-process inside the CLI, so their
 * session is 'running' for as long as one is working.
 */
export async function liveWork(): Promise<LiveWork | null> {
  if (!sources) return null
  const agents = sources.runningAgents()
  const busy = sources.busyProcesses()
  const detached = sources.detachedProcesses()
  let tasks: LiveWorkItem[] = []
  try {
    // the probe shells out to lsof; neither a failure nor a slow disk may leave
    // the app feeling unquittable, so it races a deadline and loses ties
    tasks = await Promise.race([
      sources.backgroundTasks(),
      new Promise<LiveWorkItem[]>((resolve) => setTimeout(() => resolve([]), PROBE_TIMEOUT_MS))
    ])
  } catch {
    /* treated as nothing running */
  }
  const items = [...agents, ...busy, ...detached, ...tasks]
  if (items.length === 0) return null

  const parts: string[] = []
  if (agents.length > 0)
    parts.push(
      agents.length === 1 ? 'An agent is still working' : `${agents.length} agents are still working`
    )
  if (busy.length > 0)
    parts.push(
      busy.length === 1
        ? `a terminal is still running ${busy[0].label}`
        : `${busy.length} terminals are still running (${busy.map((b) => b.label).join(', ')})`
    )
  if (detached.length > 0)
    parts.push(
      detached.length === 1
        ? `${detached[0].label} is still running in the background`
        : `${detached.length} detached processes are still running (${detached.map((d) => d.label).join(', ')})`
    )
  if (tasks.length > 0)
    parts.push(
      tasks.length === 1
        ? `a background task is still running in ${tasks[0].label}`
        : `${tasks.length} background tasks are still running`
    )
  const detail = [
    agents.length > 0
      ? 'Agents stop now and pick up right where they left off when you reopen their session.'
      : '',
    busy.length > 0 || detached.length > 0 || tasks.length > 0
      ? 'Those processes will be killed.'
      : ''
  ]
    .filter(Boolean)
    .join(' ')
  return { message: parts.join(' and ') + '.', detail, items }
}

/**
 * Ask the renderer's dialog and resolve with the user's answer. Resolves true
 * when there's no window to ask in — refusing there would trap the user in an
 * app that can neither quit nor update.
 */
export function askInterrupt(kind: InterruptKind, work: LiveWork): Promise<boolean> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.webContents.isDestroyed()) return Promise.resolve(true)
  // a second ask replaces the first; the abandoned caller must not hang
  pending?.(false)
  win.show()
  win.webContents.send('quit:confirm', { ...work, kind })
  return new Promise<boolean>((resolve) => {
    pending = resolve
  })
}

/** The renderer's answer (quit:answer). Returns false when no confirm was
 *  waiting, which the quit path treats as pre-authorization. */
export function resolveInterrupt(ok: boolean): boolean {
  const resolve = pending
  pending = null
  resolve?.(ok)
  return !!resolve
}
