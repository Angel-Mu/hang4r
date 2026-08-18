import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { killProcessGroup } from './adapters/procGroup'

const exec = promisify(execFile)

/**
 * Truthful state of a `run_in_background` Bash task, derived WITHOUT the agent
 * having to re-check it. A background command is a child of the CLI process and
 * keeps its OUTPUT FILE open for its whole life, so two independent signals
 * classify it:
 *   1. terminal markers written into the output file itself (`[exited with code
 *      N]`, `[killed]`, a `=== FINAL ===` / completed banner);
 *   2. `lsof -t <outputPath>` — the live writer pid(s) while it runs, empty once
 *      it exits (also the pid we need to STOP it individually).
 * This module is deliberately electron-free (raw node:*) so the mechanism can be
 * imported and exercised directly from an e2e test.
 */

export type BgTaskState = 'running' | 'done' | 'failed' | 'stopped'

/** Last ~`maxBytes` of a file as utf-8; '' if it can't be read (best-effort). */
async function readTail(path: string, maxBytes = 4096): Promise<string> {
  try {
    const buf = await readFile(path)
    return buf.length > maxBytes
      ? buf.subarray(buf.length - maxBytes).toString('utf8')
      : buf.toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Classify a task's outcome from its output-file tail, or null when no TERMINAL
 * marker is present yet (still running, or it ended without writing one — the
 * caller then falls back to a live-writer probe). `[killed]` wins over an exit
 * code (an interrupted task can print both); a code-0 / completion banner is
 * `done`; any non-zero exit is `failed`.
 */
export function classifyByMarker(tail: string): BgTaskState | null {
  if (!tail) return null
  if (/\[killed\]|\bkilled\b/i.test(tail)) return 'stopped'
  if (/\[exited with code 0\]|exit code:?\s*0\b/i.test(tail)) return 'done'
  if (/===\s*FINAL\s*===/i.test(tail) && /\b(completed|success)\b/i.test(tail)) return 'done'
  if (/\[exited with code [1-9]\d*\]|exit code:?\s*[1-9]/i.test(tail)) return 'failed'
  return null
}

/**
 * Pids currently holding `outputPath` open for writing — the live task process
 * and any descendants that inherited its stdout. Empty once nothing writes it
 * (the task exited). LOCAL only; `lsof` exits non-zero when no process has the
 * file open, which `execFile` surfaces as a rejection — that's "no writer", not
 * an error, so every failure maps to [].
 */
export async function liveWriterPids(outputPath: string): Promise<number[]> {
  try {
    const { stdout } = await exec('lsof', ['-t', outputPath], { timeout: 4000 })
    return stdout
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 1)
  } catch {
    return []
  }
}

/**
 * Resolve a background task's real state. Marker in the output file wins; with
 * no marker, a live writer means `running`, no live writer means it ended
 * (`done` — it just never wrote a terminal line). `remote` (ssh) output logs
 * aren't on this machine and we can't lsof the remote host, so those fall back
 * to `running` until the agent itself reports otherwise.
 */
export async function resolveBackgroundTaskState(
  outputPath: string,
  remote: boolean
): Promise<{ state: BgTaskState }> {
  if (remote) return { state: 'running' }
  const byMarker = classifyByMarker(await readTail(outputPath))
  if (byMarker) return { state: byMarker }
  const pids = await liveWriterPids(outputPath)
  return { state: pids.length > 0 ? 'running' : 'done' }
}

/** SIGTERM/SIGKILL a writer: group-kill reaches its descendants when it leads its
 *  own group (a detached background shell); the direct kill covers the common
 *  case where the writer is just a child in the CLI's group (so `-pid` ESRCHes). */
function killWriter(pid: number, signal: NodeJS.Signals): void {
  killProcessGroup(pid, signal)
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

/**
 * Stop an individual `run_in_background` task by killing whatever still holds its
 * output file open. SIGTERM first, then SIGKILL the survivors after a short
 * grace. No live writer → it already finished, `{stopped:true}`. `remote` (ssh)
 * tasks run on another host we can't reach → `{stopped:false}`.
 */
export async function stopBackgroundTask(
  outputPath: string,
  remote: boolean
): Promise<{ stopped: boolean }> {
  if (remote) return { stopped: false }
  const pids = await liveWriterPids(outputPath)
  if (pids.length === 0) return { stopped: true }
  for (const pid of pids) killWriter(pid, 'SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  for (const pid of await liveWriterPids(outputPath)) killWriter(pid, 'SIGKILL')
  return { stopped: true }
}
