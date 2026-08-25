import { BrowserWindow } from 'electron'

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
}

interface Sources {
  runningSessions: () => number
  /** terminals with a real foreground process — idle shells don't count */
  busyProcesses: () => { count: number; names: string[] }
  /** run_in_background Bash tasks still writing — these outlive their turn, so
   *  their session is usually idle by the time you quit */
  backgroundTasks: () => Promise<{ count: number; names: string[] }>
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
  const agents = sources.runningSessions()
  const busy = sources.busyProcesses()
  let tasks = { count: 0, names: [] as string[] }
  try {
    // the probe shells out to lsof; neither a failure nor a slow disk may leave
    // the app feeling unquittable, so it races a deadline and loses ties
    tasks = await Promise.race([
      sources.backgroundTasks(),
      new Promise<{ count: number; names: string[] }>((resolve) =>
        setTimeout(() => resolve({ count: 0, names: [] }), PROBE_TIMEOUT_MS)
      )
    ])
  } catch {
    /* treated as nothing running */
  }
  if (agents === 0 && busy.count === 0 && tasks.count === 0) return null

  const parts: string[] = []
  if (agents > 0)
    parts.push(agents === 1 ? 'An agent is still working' : `${agents} agents are still working`)
  if (busy.count > 0)
    parts.push(
      busy.count === 1
        ? `a terminal is still running ${busy.names[0]}`
        : `${busy.count} terminals are still running (${busy.names.join(', ')})`
    )
  if (tasks.count > 0)
    parts.push(
      tasks.count === 1
        ? `a background task is still running in ${tasks.names[0]}`
        : `${tasks.count} background tasks are still running (${[...new Set(tasks.names)].join(', ')})`
    )
  const detail = [
    agents > 0 ? 'Agents stop now and pick up right where they left off when you reopen their session.' : '',
    busy.count > 0 || tasks.count > 0 ? 'Those processes will be killed.' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return { message: parts.join(' and ') + '.', detail }
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
