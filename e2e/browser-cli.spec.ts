import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The agent-drivable integrated browser: hang4r spawns a per-session control env
 * (socket + token + a `hang4r` PATH shim) and the `hang4r browser` CLI drives the
 * session's embedded browser pane. These tests run the REAL CLI as a subprocess
 * against the REAL app (built), exactly as an agent would.
 */

const CLI = join(__dirname, '..', 'resources', 'ctl', 'hang4r-cli.js')

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

/** A self-contained test page (no server): a button that mutates the DOM + logs,
 *  a controlled-ish input that records what was typed, and a delayed mutation. */
const PAGE = `<!doctype html><html><head><title>H4R Test Page</title></head><body>
<h1>Hang4r Browser Test</h1>
<button id="go" onclick="document.getElementById('out').textContent='clicked!'; console.log('button-was-clicked')">Press Me</button>
<div id="out">idle</div>
<input id="field" placeholder="type here" oninput="window.__typed=this.value; document.getElementById('typedflag').textContent='INPUT_FIRED'" />
<div id="typedflag">no-input</div>
<button id="later" onclick="setTimeout(function(){var d=document.createElement('div');d.id='saved';d.textContent='Saved OK';document.body.appendChild(d);},250)">Delay</button>
</body></html>`
const PAGE_URL = 'data:text/html,' + encodeURIComponent(PAGE)

/**
 * Run the real CLI as a subprocess (as an agent would). ASYNC on purpose: a
 * blocking spawnSync would freeze this test process's event loop, which stalls
 * Playwright's CDP pump and the Electron renderer with it — so a `goto` that
 * needs the renderer to open a Browser tab mid-call would deadlock. Non-throwing.
 */
function runCli(
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

/** Create a local session with a Browser tab open; returns its id + the CLI env. */
async function openSessionWithBrowser(
  page: LaunchedApp['page'],
  userDataDir: string
): Promise<{ sessionId: string; env: Record<string, string> }> {
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  const sessionId = await page.evaluate(
    ({ pid }) =>
      window.hang4r
        .createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title: 'browser-cli',
          firstPrompt: 'hello'
        })
        .then((s) => s.id),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'browser-cli' }).click()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
  await page.locator('.tile-tabs button', { hasText: 'Browser' }).click()
  await page.waitForSelector('.browser-pane')
  // token comes from the ctl.token file the app wrote (CLI fallback when
  // HANG4R_CTL_TOKEN is unset) — proves the file path works
  return {
    sessionId,
    env: { HANG4R_CTL_SOCK: join(userDataDir, 'ctl.sock'), HANG4R_SESSION_ID: sessionId }
  }
}

test('goto COLD-OPENS the browser: it works even when the session tile is not on screen (Angel: the agent must be able to drive it like cmux, not error "open the tab first")', async () => {
  launched = await launchApp()
  const { page, userDataDir } = launched
  const { sessionId, env } = await openSessionWithBrowser(page, userDataDir)

  // put the session OFF SCREEN: close its tile (the session still exists, but
  // no SessionTile is mounted → no BrowserPane → no guest webContents). This is
  // the real cold state a background/worktree agent hits.
  await page.evaluate((sid) => {
    const store = (window as unknown as { __hang4r_store: { getState(): { closeTile(id: string): void } } }).__hang4r_store
    store.getState().closeTile(sid)
  }, sessionId)
  await expect(page.locator('.browser-pane')).toHaveCount(0)

  // goto must OPEN the pane itself and drive it — no human pre-opening the tab
  const goto = await runCli(['browser', 'goto', PAGE_URL], env)
  expect(goto.status, goto.stderr).toBe(0)
  expect(goto.stdout).toContain('H4R Test Page')
  // the pane is now surfaced so the user can watch the agent work
  await expect(page.locator('.browser-pane')).toHaveCount(1)
})

test('the CLI drives the browser pane end-to-end (goto, snapshot, click, type, wait, eval, screenshot, console)', async () => {
  launched = await launchApp()
  const { page, userDataDir } = launched
  const { env } = await openSessionWithBrowser(page, userDataDir)

  // goto opens a Browser tab (none was loaded) and returns the page title
  const goto = await runCli(['browser', 'goto', PAGE_URL], env)
  expect(goto.status, goto.stderr).toBe(0)
  expect(goto.stdout).toContain('H4R Test Page')

  // tabs lists the now-live tab
  const tabs = await runCli(['browser', 'tabs'], env)
  expect(tabs.status, tabs.stderr).toBe(0)
  expect(tabs.stdout).toContain('H4R Test Page')

  // snapshot emits interactive refs
  const snap = await runCli(['browser', 'snapshot'], env)
  expect(snap.status, snap.stderr).toBe(0)
  expect(snap.stdout).toMatch(/\[ref=e\d+\]/)
  expect(snap.stdout).toContain('Press Me')

  // click via a CSS selector changes the DOM (verified via get text)
  const click = await runCli(['browser', 'click', '#go'], env)
  expect(click.status, click.stderr).toBe(0)
  const afterClick = await runCli(['browser', 'get', 'text', '--selector', '#out'], env)
  expect(afterClick.stdout.trim()).toBe('clicked!')

  // type dispatches a real input event (page records the value AND sets a flag)
  const type = await runCli(['browser', 'type', '#field', 'hello world'], env)
  expect(type.status, type.stderr).toBe(0)
  const typedFlag = await runCli(['browser', 'get', 'text', '--selector', '#typedflag'], env)
  expect(typedFlag.stdout.trim()).toBe('INPUT_FIRED')
  const typedVal = await runCli(['browser', 'eval', 'window.__typed'], env)
  expect(typedVal.stdout.trim()).toBe('"hello world"')

  // eval returns JSON
  const evalRes = await runCli(['browser', 'eval', 'document.title'], env)
  expect(evalRes.stdout.trim()).toBe('"H4R Test Page"')

  // wait --text resolves after a delayed mutation the click triggers
  await runCli(['browser', 'click', '#later'], env)
  const waited = await runCli(['browser', 'wait', '--text', 'Saved OK', '--timeout', '5000'], env)
  expect(waited.status, waited.stderr).toBe(0)
  expect(waited.stdout).toContain('matched')

  // console shows the log line the click produced
  const con = await runCli(['browser', 'console'], env)
  expect(con.status, con.stderr).toBe(0)
  expect(con.stdout).toContain('button-was-clicked')

  // screenshot writes a real PNG
  const shotPath = join(tmpdir(), `h4r-shot-${Date.now()}.png`)
  const shot = await runCli(['browser', 'screenshot', shotPath], env)
  expect(shot.status, shot.stderr).toBe(0)
  expect(shot.stdout.trim()).toBe(shotPath)
  expect(existsSync(shotPath)).toBe(true)
  expect(statSync(shotPath).size).toBeGreaterThan(0)
})

test('the CLI fails honestly: bad token is rejected, unknown session is a clear error', async () => {
  launched = await launchApp()
  const { page, userDataDir } = launched
  const { env } = await openSessionWithBrowser(page, userDataDir)

  // wrong token → non-zero exit + an auth error on stderr
  const bad = await runCli(['browser', 'tabs'], { ...env, HANG4R_CTL_TOKEN: 'not-the-token' })
  expect(bad.status).not.toBe(0)
  expect(bad.stderr.toLowerCase()).toContain('unauthorized')

  // valid token but a session with no browser → an actionable error
  const unknown = await runCli(['browser', 'snapshot'], { ...env, HANG4R_SESSION_ID: 'does-not-exist' })
  expect(unknown.status).not.toBe(0)
  expect(unknown.stderr).toContain('no browser tab open')
})

test('per-session control env lands in a worktree setup script (socket + session id)', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  const project = await createProject(page, repo)
  await page.evaluate(async () => {
    await window.hang4r.setSetting('setupScript', 'env > ENV_DUMP.txt')
  })
  const session = await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'worktree',
        permissionMode: 'default',
        title: 'env-plumb',
        firstPrompt: 'hello'
      }),
    { pid: project.id }
  )

  const dump = join(session.cwd, 'ENV_DUMP.txt')
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true)
  const env = readFileSync(dump, 'utf8')
  expect(env).toContain(`HANG4R_SESSION_ID=${session.id}`)
  expect(env).toMatch(/HANG4R_CTL_SOCK=.*ctl\.sock/)
  expect(env).toMatch(/HANG4R_CTL_TOKEN=/)
})
