import { test, expect } from '@playwright/test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The per-session Processes tab runs dev/service commands (`npm run dev`, …) in a
 * pty via startProcess. Two guarantees, both reported broken by Angel:
 *
 *  (a) quitting hang4r while such a process is live must WARN (like the other
 *      close guards) — busyCount() counts commandPtys as always-busy.
 *  (b) killing that process (on quit-confirm, or when its tab is disposed) must
 *      actually free the port.
 *
 * Root cause for (b), confirmed by experiment: node-pty runs the command under a
 * `<shell> -lc` leader that setsid()s into its own process group; the real port
 * holder is a CHILD in that group. `pty.kill()` signals ONLY the leader — a child
 * that OBEYS SIGHUP then dies via the master-close hangup cascade, but a child
 * that RESISTS SIGHUP (real dev servers install signal handlers / spawn detached
 * workers) is ORPHANED and keeps its port. dispose() must kill the whole GROUP.
 *
 * These tests model that worst case with a `trap "" HUP` child that records the
 * pid of a long-lived grandchild; we assert that pid is dead after the kill.
 */

let launched: LaunchedApp | null = null
/** pid files of any survivor grandchildren, so a pre-fix (orphaning) run leaves
 *  nothing running on the machine after the test tears down */
const cleanupPidFiles = new Set<string>()

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
  for (const f of cleanupPidFiles) {
    try {
      const pid = parseInt(readFileSync(f, 'utf8').trim(), 10)
      if (pid) process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  cleanupPidFiles.clear()
})

/** Create an IDLE session (no firstPrompt → no agent turn), so the quit guard can
 *  only be tripped by a live process, not by a running agent. */
async function makeIdleSession(page: LaunchedApp['page']): Promise<string> {
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  return page.evaluate(
    ({ pid }) =>
      window.hang4r
        .createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title: 'proc-guard'
        })
        .then((s) => s.id),
    { pid: project.id }
  )
}

/** A SIGHUP-resistant service process that records its port-holder grandchild pid
 *  to `pidFile` and stays alive (via `wait`). Returns the command string. */
function serviceCommand(pidFile: string): string {
  cleanupPidFiles.add(pidFile)
  return `sh -c 'trap "" HUP; sleep 100000 & echo $! > ${pidFile}; wait'`
}

/** Start the process and resolve the (alive) grandchild pid it recorded. */
async function startServiceAndGetChild(
  page: LaunchedApp['page'],
  sessionId: string
): Promise<{ procId: string; childPid: number }> {
  const procId = `dev:${sessionId}:0`
  const pidFile = join(mkdtempSync(join(tmpdir(), 'hang4r-procgrp-')), 'child.pid')
  const command = serviceCommand(pidFile)
  await page.evaluate(({ id, sid, cmd }) => window.hang4r.startProcess(id, sid, cmd, 120, 30), {
    id: procId,
    sid: sessionId,
    cmd: command
  })
  await expect
    .poll(
      () => {
        if (!existsSync(pidFile)) return 0
        const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        if (!pid) return 0
        try {
          process.kill(pid, 0)
          return pid
        } catch {
          return 0
        }
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0)
  return { procId, childPid: parseInt(readFileSync(pidFile, 'utf8').trim(), 10) }
}

/** Poll until `pid` is dead (kill -0 throws ESRCH). */
async function expectDead(pid: number, timeout = 6_000): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0)
          return true // alive → orphaned
        } catch {
          return false // dead → freed
        }
      },
      { timeout }
    )
    .toBe(false)
}

test('quitting with a live Processes-tab process WARNS that the process will be killed', async () => {
  // HANG4R_TEST_QUIT_GUARD forces the guard even in quiet (e2e) mode
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  const sessionId = await makeIdleSession(page)
  await startServiceAndGetChild(page, sessionId)

  // capture the next quit:confirm on the renderer side
  await page.evaluate(() => {
    ;(window as unknown as { __quit: unknown }).__quit = null
    window.hang4r.onQuitConfirm((info) => {
      ;(window as unknown as { __quit: unknown }).__quit = info
    })
  })

  // trigger the quit path; the guard should preventDefault and send quit:confirm
  await launched.app.evaluate(({ app }) => app.quit())

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __quit: unknown }).__quit), {
      timeout: 10_000
    })
    .not.toBe(null)
  const info = await page.evaluate(
    () => (window as unknown as { __quit: { message: string; detail: string } }).__quit
  )
  // the "Those processes will be killed." detail line appears ONLY when a live
  // process tripped the guard — so its presence proves (a)
  expect(info.detail).toContain('killed')
  expect(info.message.toLowerCase()).toContain('running')

  // release the guard so the app (and its orphan-prone child) tears down cleanly
  await page.evaluate(() => window.hang4r.answerQuitConfirm(true))
})

test('disposing a Processes-tab process kills its whole process group (frees the port)', async () => {
  launched = await launchApp()
  const { page } = launched
  const sessionId = await makeIdleSession(page)
  const { procId, childPid } = await startServiceAndGetChild(page, sessionId)

  // dispose the process (as closing its Processes tab does)
  await page.evaluate((id) => window.hang4r.disposeTerminal(id), procId)

  // the SIGHUP-resistant grandchild (port holder) must be GONE — group kill
  await expectDead(childPid)
})

test('confirming quit kills a live process group (frees the port on app quit)', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  const sessionId = await makeIdleSession(page)
  const { childPid } = await startServiceAndGetChild(page, sessionId)

  // confirm quit → disposeAll() runs on before-quit; app tears down
  await page.evaluate(() => window.hang4r.answerQuitConfirm(true))
  await launched.app.close().catch(() => {})
  launched = null

  // after the app is gone, the SIGHUP-resistant child must NOT survive
  await expectDead(childPid)
})
