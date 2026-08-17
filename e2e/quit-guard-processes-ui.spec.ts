import { test, expect } from '@playwright/test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * DIAGNOSTIC (do-not-fix) companion to quit-guard-processes.spec.ts.
 *
 * Angel's report: run a dev/service process from a session's *Processes tab*,
 * then ⌘Q — NO quit-confirmation prompt fires and the process's port stays
 * occupied. The existing quit-guard spec passes because it starts the process by
 * calling window.hang4r.startProcess(...) DIRECTLY, bypassing the real UI. This
 * spec drives the process the two ways Angel actually can, and records, at each
 * step, the ground truth of whether the quit guard WOULD fire.
 *
 * Evidence channels (no source changes — getPtyService() is internal to the
 * bundle and not callable from app.evaluate):
 *   - processRunning('dev:<sid>:<i>')  → is the pty in PtyService.ptys (isRunning)
 *   - grandchild pid alive (pidFile)   → the real port-holder still exists
 *   - the quit:confirm MESSAGE          → the guard writes busyCount().count and
 *                                         .names verbatim into it, so capturing
 *                                         it reads the real busyCount() output:
 *                                           1 proc  → "a terminal is still running <name>"
 *                                           N procs → "N terminals are still running (names)"
 *                                           +detail "Those processes will be killed."
 *     For an IDLE session (no firstPrompt → 0 running agents) the guard can ONLY
 *     be tripped by a live process, so quit:confirm firing ⟺ busyCount().count>0.
 *
 * NOTE on busyCount fidelity: startCommand() always registers a dev id in BOTH
 * ptys and commandPtys, and busyCount() counts every commandPtys id as busy while
 * alive. So for a dev:* id, processRunning()===true ⟺ busyCount() counts it. The
 * quit:confirm at the end is the authoritative confirmation.
 */

let launched: LaunchedApp | null = null
const cleanupPidFiles = new Set<string>()

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
  // SIGKILL any survivor grandchild so a pre-fix orphan never lingers on Angel's machine
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

/** A SIGHUP-resistant service that stays FOREGROUND (via `wait`, so the pty leader
 *  stays alive) and records its port-holder grandchild pid to `pidFile`. */
function serviceCommand(pidFile: string): string {
  cleanupPidFiles.add(pidFile)
  return `sh -c 'trap "" HUP; sleep 100000 & echo $! > ${pidFile}; wait'`
}

function newPidFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'hang4r-procui-')), 'child.pid')
}

/** poll the pidFile until it names a live pid; return it, or 0 if it never came
 *  alive (non-throwing so the diagnostic can still record "pty never started"). */
async function pollChildPid(pidFile: string, timeout = 10_000): Promise<number> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (pid) {
        try {
          process.kill(pid, 0)
          return pid
        } catch {
          /* not alive yet */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return 0
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false // never probe pid 0 (our own process group)
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Subscribe to the next quit:confirm, trigger app.quit(), and report whether the
 *  guard fired (and with what message/detail) or the app quit unprompted. */
async function probeQuit(
  l: LaunchedApp
): Promise<{ fired: boolean; message: string; detail: string }> {
  await l.page.evaluate(() => {
    ;(window as unknown as { __quit: unknown }).__quit = null
    window.hang4r.onQuitConfirm((info) => {
      ;(window as unknown as { __quit: unknown }).__quit = info
    })
  })
  await l.app.evaluate(({ app }) => app.quit())
  // give the guard a beat to either send quit:confirm or let the app go
  let info: { message: string; detail: string } | null = null
  for (let i = 0; i < 40; i++) {
    info = await l.page
      .evaluate(() => (window as unknown as { __quit: { message: string; detail: string } | null }).__quit)
      .catch(() => null)
    if (info) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return { fired: !!info, message: info?.message ?? '', detail: info?.detail ?? '' }
}

async function makeIdleSession(page: LaunchedApp['page'], projectId: string, title: string): Promise<string> {
  return page.evaluate(
    ({ pid, t }) =>
      window.hang4r
        .createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title: t
        })
        .then((s) => s.id),
    { pid: projectId, t: title }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH 1 — real Processes-tab UI: persist a (non-autoStart) dev process, open the
// session tile, switch its context tab to Processes, click the real ▶ Start.
// ─────────────────────────────────────────────────────────────────────────────
test('PATH1 manual ▶ Start button in the Processes tab', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  const pidFile = newPidFile()

  // persist the config the panel reads (autoStart OFF → only the Start button runs it)
  await page.evaluate(
    ({ pid, cmd }) =>
      window.hang4r.setSetting(
        `devProcesses:${pid}`,
        JSON.stringify([{ name: 'svc', command: cmd }])
      ),
    { pid: project.id, cmd: serviceCommand(pidFile) }
  )

  const sid = await makeIdleSession(page, project.id, 'manual-proc')
  const procId = `dev:${sid}:0`
  await page.reload()
  await page.waitForSelector('.app')

  // open the session tile
  await page.locator('.session-row', { hasText: 'manual-proc' }).click()
  await page.locator('.tile-title', { hasText: 'manual-proc' }).first().waitFor({ timeout: 20_000 })

  // switch the context tab to Processes and click the REAL Start button
  await page.locator('.tile-tabs button', { hasText: 'Processes' }).click()
  await page.locator('.proc-start').first().waitFor({ timeout: 10_000 })
  await page.locator('.proc-start').first().click()

  // the grandchild (port holder) coming alive proves the pty really started
  const childPid = await pollChildPid(pidFile)

  // EVIDENCE A: pty tracked right after Start
  const runningAfterStart = await page.evaluate((id) => window.hang4r.processRunning(id), procId)

  // LIFECYCLE PROBE: switch the context tab AWAY (unmounts ProcessesPanel + its
  // TerminalView), then check the pty survived
  await page.locator('.tile-tabs button', { hasText: 'Diff' }).click()
  await page.waitForTimeout(300)
  const runningAfterTabAway = await page.evaluate((id) => window.hang4r.processRunning(id), procId)
  const childAliveAfterTabAway = pidAlive(childPid)

  // EVIDENCE B: the quit guard
  const quit = await probeQuit(launched)

  // structured evidence dump (prints regardless of the assertions below)
  console.log(
    '\n[PATH1 manual Start] EVIDENCE ' +
      JSON.stringify(
        {
          procId,
          runningAfterStart,
          runningAfterTabAway,
          childAliveAfterTabAway,
          quitConfirmFired: quit.fired,
          quitMessage: quit.message,
          quitDetail: quit.detail
        },
        null,
        2
      )
  )

  // release the guard so the app tears down cleanly (kills the orphan-prone child)
  await page.evaluate(() => window.hang4r.answerQuitConfirm(true)).catch(() => {})

  // regression expectations (a live Processes-tab process MUST warn on quit)
  expect(runningAfterStart).toBe(true)
  expect(runningAfterTabAway).toBe(true)
  expect(quit.fired).toBe(true)
  expect(quit.detail.toLowerCase()).toContain('killed')
})

// ─────────────────────────────────────────────────────────────────────────────
// PATH 2 — "run on agent start": persist an autoStart process, create a session,
// and let ipc.ts sessions:create auto-launch it (ptyService.startCommand). This
// path never mounts a TerminalView.
// ─────────────────────────────────────────────────────────────────────────────
test('PATH2 autoStart "run on agent start" (no TerminalView)', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  const pidFile = newPidFile()

  await page.evaluate(
    ({ pid, cmd }) =>
      window.hang4r.setSetting(
        `devProcesses:${pid}`,
        JSON.stringify([{ name: 'svc', command: cmd, autoStart: true }])
      ),
    { pid: project.id, cmd: serviceCommand(pidFile) }
  )

  const sid = await makeIdleSession(page, project.id, 'auto-proc')
  const procId = `dev:${sid}:0`

  // the auto-start runs fire-and-forget inside sessions:create → poll for the pty
  const childPid = await pollChildPid(pidFile)
  const runningAfterCreate = await page.evaluate((id) => window.hang4r.processRunning(id), procId)

  // we never opened the tile / Processes tab for this path — confirm no TerminalView
  const terminalViewsMounted = await page.evaluate(() => document.querySelectorAll('.terminal-view').length)

  const quit = await probeQuit(launched)

  console.log(
    '\n[PATH2 autoStart] EVIDENCE ' +
      JSON.stringify(
        {
          procId,
          runningAfterCreate,
          childAlive: pidAlive(childPid),
          terminalViewsMounted,
          quitConfirmFired: quit.fired,
          quitMessage: quit.message,
          quitDetail: quit.detail
        },
        null,
        2
      )
  )

  await page.evaluate(() => window.hang4r.answerQuitConfirm(true)).catch(() => {})

  expect(runningAfterCreate).toBe(true)
  expect(quit.fired).toBe(true)
  expect(quit.detail.toLowerCase()).toContain('killed')
})

// ─────────────────────────────────────────────────────────────────────────────
// PATH 3 — REPRODUCTION: a self-detaching dev server. The command backgrounds a
// SIGHUP-ignoring port-holder and RETURNS, so the pty shell LEADER exits right
// away. pty.onExit then deletes the id from BOTH ptys and commandPtys, so
// busyCount() forgets it — while the detached grandchild keeps holding the port.
// This is path-independent (manual Start and autoStart both call startCommand);
// we use autoStart for determinism. Expected to REPRODUCE Angel: no quit prompt,
// and the port holder survives the quit.
// ─────────────────────────────────────────────────────────────────────────────
test('PATH3 self-detaching dev server (leader exits early) — REPRODUCES no-prompt', async () => {
  launched = await launchApp({ env: { HANG4R_TEST_QUIT_GUARD: '1' } })
  const { page, app } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  const pidFile = newPidFile()

  // background a HUP-ignoring child, then EXIT — the leader does not stay foreground.
  // `trap "" HUP` before the spawn makes the ignored disposition inherit into sleep,
  // so it survives the pty hangup; the leader returns immediately (no `wait`).
  const detachingCmd = `sh -c 'trap "" HUP; sleep 100000 & echo $! > ${pidFile}; exit 0'`
  cleanupPidFiles.add(pidFile)

  await page.evaluate(
    ({ pid, cmd }) =>
      window.hang4r.setSetting(
        `devProcesses:${pid}`,
        JSON.stringify([{ name: 'svc', command: cmd, autoStart: true }])
      ),
    { pid: project.id, cmd: detachingCmd }
  )

  const sid = await makeIdleSession(page, project.id, 'detach-proc')
  const procId = `dev:${sid}:0`

  // the port-holder grandchild comes alive…
  const childPid = await pollChildPid(pidFile)
  // …and we wait for the pty LEADER to exit (the detaching command returns fast),
  // which is exactly the state Angel is in when he later quits.
  let runningAfterDetach = true
  for (let i = 0; i < 30; i++) {
    runningAfterDetach = await page.evaluate((id) => window.hang4r.processRunning(id), procId)
    if (!runningAfterDetach) break
    await new Promise((r) => setTimeout(r, 100))
  }

  // now quit — with the leader gone, busyCount() has forgotten the process
  const quit = await probeQuit(launched)

  // ensure the app is fully down, then check whether the port holder survived
  await app.close().catch(() => {})
  launched = null
  await new Promise((r) => setTimeout(r, 500))
  const childSurvivedQuit = pidAlive(childPid)

  console.log(
    '\n[PATH3 self-detaching] EVIDENCE ' +
      JSON.stringify(
        {
          procId,
          childPidStarted: childPid,
          runningAfterDetach, // false → pty leader already exited (id dropped from busyCount)
          quitConfirmFired: quit.fired, // false → NO prompt (reproduces Angel)
          quitMessage: quit.message,
          childSurvivedQuit // true → orphaned port holder outlives the app (port stays occupied)
        },
        null,
        2
      )
  )

  // this documents the BUG (diagnostic): with the leader gone, the guard is blind
  expect(childPid).toBeGreaterThan(0)
  expect(runningAfterDetach).toBe(false)
  expect(quit.fired).toBe(false) // ← reproduces "no quit-confirmation prompt"
  expect(childSurvivedQuit).toBe(true) // ← reproduces "port stays occupied"
})
