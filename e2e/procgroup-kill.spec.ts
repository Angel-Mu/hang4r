import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessGroup } from '../src/main/services/adapters/procGroup'

/**
 * MECHANISM PROOF for the zombie-port fix (v1.0.108).
 *
 * The Claude/Codex/Cursor adapters now spawn their CLI with `detached: true`
 * (making the CLI its own process-group leader, pgid === pid) and, on dispose(),
 * group-kill via killProcessGroup(pid, …) === process.kill(-pid, …). This test
 * proves the mechanism directly, without a real CLI:
 *
 *   - A detached "leader" backgrounds a long-running grandchild (the port holder)
 *     and `wait`s, exactly like a CLI that launched a background dev server.
 *   - Test 1: killProcessGroup(leader.pid, SIGKILL) reaches the grandchild too —
 *     it is gone (process.kill(pid,0) throws ESRCH). This is the fix.
 *   - Test 2 (contrast): killing ONLY the leader pid (the OLD behavior) leaves the
 *     grandchild alive and orphaned — the zombie holding port 3000/4000. This is
 *     why leader-only kill was insufficient.
 *
 * No Electron app is launched; this is a pure OS-level test of the shared helper.
 */

const survivors = new Set<number>()

test.afterEach(() => {
  // SIGKILL any grandchild that outlived its test so nothing lingers on the box
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  survivors.clear()
})

/** Spawn a DETACHED leader that backgrounds a SIGHUP-resistant grandchild (recording
 *  its pid to `pidFile`) and stays foreground via `wait`, so the group persists. */
function spawnDetachedLeader(pidFile: string): ReturnType<typeof spawn> {
  return spawn('sh', ['-c', `trap "" HUP; sleep 100000 & echo $! > ${pidFile}; wait`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    // own process group (pgid === pid) — mirrors the adapters' spawn options
    detached: true
  })
}

function newPidFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'hang4r-pgkill-')), 'child.pid')
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** poll the pidFile until it names a live pid; return it (or 0 if it never came alive) */
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

async function waitUntilDead(pid: number, timeout = 5000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !pidAlive(pid)
}

test('group-kill terminates a detached leader’s grandchild (the port holder)', async () => {
  const pidFile = newPidFile()
  const leader = spawnDetachedLeader(pidFile)
  const leaderPid = leader.pid
  expect(leaderPid, 'leader must have a pid').toBeTruthy()

  const grandchildPid = await pollGrandchildPid(pidFile)
  survivors.add(grandchildPid) // teardown safety net
  expect(grandchildPid, 'grandchild (port holder) must come alive').toBeGreaterThan(1)
  expect(pidAlive(grandchildPid)).toBe(true)

  // THE FIX: group-kill the leader's whole process group via the shared helper
  killProcessGroup(leaderPid!, 'SIGKILL')

  // the grandchild must be gone — process.kill(pid,0) now throws ESRCH
  expect(await waitUntilDead(grandchildPid), 'grandchild must die with the group').toBe(true)
  expect(() => process.kill(grandchildPid, 0)).toThrow(/ESRCH/)
  survivors.delete(grandchildPid)
})

test('leader-only kill ORPHANS the grandchild (why group-kill is needed)', async () => {
  const pidFile = newPidFile()
  const leader = spawnDetachedLeader(pidFile)
  const leaderPid = leader.pid!
  const grandchildPid = await pollGrandchildPid(pidFile)
  survivors.add(grandchildPid)
  expect(grandchildPid).toBeGreaterThan(1)

  // OLD behavior: kill ONLY the leader's own pid (positive pid, not the group)
  process.kill(leaderPid, 'SIGKILL')
  await waitUntilDead(leaderPid)

  // the grandchild is orphaned but still alive — the zombie that keeps its port
  await new Promise((r) => setTimeout(r, 600))
  expect(pidAlive(grandchildPid), 'leader-only kill must leave the grandchild alive').toBe(true)

  // now clean it up with a group-kill (proves the group still reaches it) + teardown
  killProcessGroup(leaderPid, 'SIGKILL')
  await waitUntilDead(grandchildPid)
})
