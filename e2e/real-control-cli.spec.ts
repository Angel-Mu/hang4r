import { test, expect, _electron as electron } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeScratchRepo, createProject } from './helpers'

/**
 * REAL-agent completion gate for the control CLI: the actual `hang4r` CLI script
 * (ELECTRON_RUN_AS_NODE, as an outside agent would run it) drives the built app
 * running the REAL claude backend (haiku). Fake-agent control-cli.spec.ts is
 * regression only; this decides whether the feature works.
 *
 *   HANG4R_REAL_E2E=1 npx playwright test e2e/real-control-cli.spec.ts
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ELECTRON_BIN: string = require('electron')
const CLI = join(__dirname, '..', 'resources', 'ctl', 'hang4r-cli.js')

interface Run {
  status: number | null
  stdout: string
  stderr: string
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
  err: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** ASYNC on purpose: a blocking spawn would stall the Electron renderer. */
function runCli(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON_BIN, [CLI, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HANG4R_CTL_SOCK: '', HANG4R_CTL_TOKEN: '', ...env }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.end()
    child.on('close', (status) => {
      const parse = (s: string): unknown => {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      }
      resolve({ status, stdout, stderr, json: parse(stdout), err: parse(stderr) })
    })
  })
}

test.describe('real claude + control CLI', () => {
  test.skip(process.env.HANG4R_REAL_E2E !== '1', 'set HANG4R_REAL_E2E=1 to run')
  test.setTimeout(480_000)

  test('outside agent starts a session, Angel continues it in the app, the CLI continues it again', async () => {
    const userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'hang4r-real-ctl-')))
    const app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, HANG4R_FAKE_AGENT: '0', HANG4R_USER_DATA_DIR: userDataDir, HANG4R_QUIET_TEST: '1' }
    })
    const page = await app.firstWindow()
    await page.waitForSelector('.app', { timeout: 20_000 })
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    const env = { HANG4R_USER_DATA: userDataDir }
    const cli = (...a: string[]): Promise<Run> => runCli(a, env)
    const token = 'PONG-' + Math.random().toString(36).slice(2, 10).toUpperCase()

    // 1. outside agent starts a real session and waits for the turn
    const made = await cli(
      'sessions', 'new', '--project', repo, '--backend', 'claude', '--env', 'local', '--model', 'haiku',
      '--as', 'e2e-bot', '--json', '--wait', `Reply with exactly: ${token}`
    )
    console.log('NEW', made.status, made.stdout.slice(0, 600), made.stderr.slice(0, 300))
    expect(made.status).toBe(0)
    expect(made.json.reason).toBe('turn-complete')
    expect(made.json.result).toContain(token)
    const id: string = made.json.session.id

    // 2. sidebar origin marker + per-message via label
    await expect(page.locator('[aria-label="via e2e-bot"]').first()).toBeVisible({ timeout: 15_000 })
    await page.locator('.session-row').first().click()
    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(tile.locator('.msg-user-card').first()).toContainText('via e2e-bot')
    await expect(tile.locator('.msg-assistant').last()).toContainText(token)

    // 3. Angel continues in the app
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 30_000 })
    await tile.locator('.composer-input').fill('What exact token did you reply with before? Answer with only the token.')
    await tile.getByRole('button', { name: 'Send' }).click()
    await expect(tile.locator('.msg-assistant').last()).toContainText(token, { timeout: 180_000 })
    await expect(tile.locator('.msg-user-card')).toHaveCount(2)
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 60_000 })

    // 4. CLI continues again
    const second = await cli('sessions', 'send', id, '--wait', '--json', '--as', 'e2e-bot', 'Reply with exactly: SECOND')
    console.log('SEND', second.status, second.stdout.slice(0, 400), second.stderr.slice(0, 300))
    expect(second.status).toBe(0)
    expect(second.json.result).toContain('SECOND')
    const shown = await cli('sessions', 'show', id, '--json')
    expect(shown.status).toBe(0)
    expect((shown.json.session ?? shown.json).status).toBe('idle')

    // 5. busy: a slow turn is in flight, a second send is refused with exit 5
    const slow = await cli(
      'sessions', 'send', id, '--json', '--as', 'e2e-bot',
      'Use the Bash tool to run `sleep 30`, then reply DONE.'
    )
    console.log('SLOW', slow.status, slow.stdout.slice(0, 300), slow.stderr.slice(0, 300))
    expect(slow.status).toBe(0)
    const busy = await cli('sessions', 'send', id, '--json', 'too soon')
    console.log('BUSY', busy.status, busy.stderr.slice(0, 300))
    expect(busy.status).toBe(5)
    await cli('sessions', 'interrupt', id)

    await app.close()
  })
})
