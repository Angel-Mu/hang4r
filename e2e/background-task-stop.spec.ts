import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  stopBackgroundTask,
  liveWriterPids,
  classifyByMarker,
  resolveBackgroundTaskState
} from '../src/main/services/backgroundTask'

/**
 * MECHANISM PROOF for per-task stop + truthful status (v1.0.109).
 *
 * A `run_in_background` task is a child of the CLI and keeps its OUTPUT FILE
 * open for its whole life, so `lsof -t <outputPath>` yields the live writer
 * pid(s) — a definitive liveness signal AND the pid to kill. This test drives
 * the shared module directly (electron-free), with no Electron app:
 *
 *   - A DETACHED leader backgrounds a long-running grandchild whose stdout is the
 *     task's output file (both hold the fd open), exactly like a background dev
 *     server writing to its log.
 *   - stopBackgroundTask(outputPath) lsofs the file, group+direct kills every
 *     writer → the grandchild is gone (process.kill(pid,0) throws ESRCH).
 *   - classify/resolve helpers map the output-file markers + writer probe to the
 *     truthful running/done/failed/stopped state the Tasks tab now shows.
 */

const survivors = new Set<number>()
const openFds: number[] = []

test.afterEach(() => {
  for (const fd of openFds.splice(0)) {
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
  }
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  survivors.clear()
})

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number, timeout = 5000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !pidAlive(pid)
}

/** Spawn a DETACHED leader whose stdout IS `logFile` (so it + its backgrounded
 *  grandchild both hold that file open), recording the grandchild pid. Mirrors a
 *  background command writing to its output file. */
function spawnTaskWriter(logFile: string, pidFile: string): number {
  const out = openSync(logFile, 'w')
  const leader = spawn('sh', ['-c', `sleep 100000 & echo $! > ${pidFile}; wait`], {
    stdio: ['ignore', out, 'ignore'],
    detached: true
  })
  closeSync(out) // only sh + sleep hold the log open now, not this test process
  return leader.pid!
}

async function pollGrandchildPid(pidFile: string, timeout = 10_000): Promise<number> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (pid && pidAlive(pid)) return pid
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return 0
}

test('stopBackgroundTask kills the writer(s) holding the output file open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hang4r-bgstop-'))
  const logFile = join(dir, 'task.log')
  const pidFile = join(dir, 'child.pid')

  const leaderPid = spawnTaskWriter(logFile, pidFile)
  expect(leaderPid, 'leader must have a pid').toBeTruthy()
  const grandchildPid = await pollGrandchildPid(pidFile)
  survivors.add(grandchildPid) // teardown safety net
  expect(grandchildPid, 'grandchild (log writer) must come alive').toBeGreaterThan(1)

  // lsof sees the live writer(s) — this is the liveness signal the status poll uses
  const before = await liveWriterPids(logFile)
  expect(before, 'output file must have a live writer while the task runs').toContain(grandchildPid)

  // THE STOP: kill whatever holds the output file open
  const res = await stopBackgroundTask(logFile, false)
  expect(res).toEqual({ stopped: true })

  expect(await waitUntilDead(grandchildPid), 'grandchild must die when the task is stopped').toBe(
    true
  )
  expect(() => process.kill(grandchildPid, 0)).toThrow(/ESRCH/)
  survivors.delete(grandchildPid)

  // nothing holds it open now → a second stop is a no-op success
  expect(await liveWriterPids(logFile)).toHaveLength(0)
  expect(await stopBackgroundTask(logFile, false)).toEqual({ stopped: true })
  // remote (ssh) tasks run on a host we can't reach
  expect(await stopBackgroundTask(logFile, true)).toEqual({ stopped: false })
})

test('classifyByMarker maps output-file terminal markers to task state', () => {
  expect(classifyByMarker('dev server starting…\n[exited with code 0]\n')).toBe('done')
  expect(classifyByMarker('boom\n[exited with code 1]\n')).toBe('failed')
  expect(classifyByMarker('exit code: 137\n')).toBe('failed')
  expect(classifyByMarker('caught signal\n[killed]\n')).toBe('stopped')
  // killed wins over an exit code (an interrupted task can print both)
  expect(classifyByMarker('[exited with code 0]\nprocess killed\n')).toBe('stopped')
  expect(classifyByMarker('=== FINAL ===\nall steps completed\n')).toBe('done')
  // no terminal marker yet → null (caller falls back to a live-writer probe)
  expect(classifyByMarker('still working…\n')).toBeNull()
  expect(classifyByMarker('')).toBeNull()
})

test('resolveBackgroundTaskState: marker wins, else the live-writer probe decides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hang4r-bgresolve-'))

  // no marker + no live writer → the task ended without writing one → done
  const idle = join(dir, 'idle.log')
  writeFileSync(idle, 'ran and quietly finished\n')
  expect(await resolveBackgroundTaskState(idle, false)).toEqual({ state: 'done' })

  // a terminal marker classifies it regardless of any writer
  const killed = join(dir, 'killed.log')
  writeFileSync(killed, 'was interrupted\n[killed]\n')
  expect(await resolveBackgroundTaskState(killed, false)).toEqual({ state: 'stopped' })

  // remote (ssh) output isn't on this box → marker-only, stays running
  const remote = join(dir, 'remote.log')
  writeFileSync(remote, 'no marker\n')
  expect(await resolveBackgroundTaskState(remote, true)).toEqual({ state: 'running' })

  // no marker + a LIVE writer → running
  const live = join(dir, 'live.log')
  const fd = openSync(live, 'w')
  openFds.push(fd)
  expect(await resolveBackgroundTaskState(live, false)).toEqual({ state: 'running' })
  closeSync(openFds.pop()!)
})
