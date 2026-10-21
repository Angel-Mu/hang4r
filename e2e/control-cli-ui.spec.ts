import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/** What Angel sees of the hang4r command: the origin chip, the per-turn label, the Settings section. */

const CLI = join(__dirname, '..', 'resources', 'ctl', 'hang4r-cli.js')

function runCli(args: string[], userData: string): Promise<{ status: number | null; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, HANG4R_CTL_SOCK: '', HANG4R_CTL_TOKEN: '', HANG4R_USER_DATA: userData }
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stdin.end()
    child.on('close', (status) => {
      let json = null
      try {
        json = JSON.parse(out)
      } catch {
        /* not json */
      }
      resolve({ status, json })
    })
  })
}

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('an externally created session shows its origin chip and "via" label, and keeps both after reload and restart', async () => {
  launched = await launchApp()
  let { page } = launched
  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  const r = await runCli(
    ['sessions', 'new', 'hello from outside', '--project', basename(repo), '--env', 'local', '--wait', '--json', '--as', 'uitest'],
    launched.userDataDir
  )
  expect(r.status).toBe(0)
  const id: string = r.json.session.id

  const check = async (): Promise<void> => {
    const row = page.locator('.session-row', { has: page.locator('.session-origin') })
    await expect(row.locator('.session-origin')).toHaveText('via uitest')
    await row.click()
    const bubble = page.locator('.tile .msg-user-card', { hasText: 'hello from outside' })
    await expect(bubble.locator('.msg-origin')).toHaveText('via uitest')
  }

  // live: the window was already open when the CLI made the session
  await check()
  // only the one CLI-made session carries a chip
  expect(await page.locator('.session-origin').count()).toBe(1)

  await page.reload()
  await page.waitForSelector('.app')
  await check()

  const dir = launched.userDataDir
  await launched.app.close()
  launched = await launchApp({ userDataDir: dir })
  page = launched.page
  await check()
  expect(id).toBeTruthy()
  await page.screenshot({ path: join(process.env.UI_SHOT_DIR ?? tmpdir(), 'control-cli-origin.png') })
})

test('Settings > Command line renders and Install reports its result without touching the real HOME', async () => {
  const home = mkdtempSync(join(tmpdir(), 'h4r-home-ui-'))
  launched = await launchApp({ env: { HOME: home } })
  const { page, app } = launched
  expect(await app.evaluate(() => process.env.HOME)).toBe(home)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'settings')
  )
  await page.locator('.settings-nav-item', { hasText: 'Command line' }).click()
  await expect(page.locator('.settings-body code', { hasText: 'hang4r' }).first()).toBeVisible()
  await expect(page.locator('.cli-install-line', { hasText: 'hang4r sessions new --project <path> "…"' })).toBeVisible()

  await page.getByRole('button', { name: 'Install hang4r command' }).click()
  const result = page.getByTestId('cli-install-result')
  await expect(result).toContainText(join(home, '.local', 'bin', 'hang4r'))
  expect(existsSync(join(home, '.local', 'bin', 'hang4r'))).toBe(true)
  await page.screenshot({ path: join(process.env.UI_SHOT_DIR ?? tmpdir(), 'control-cli-settings.png') })

  await page.getByRole('button', { name: 'Uninstall' }).click()
  await expect(result).toContainText('Removed')
  expect(existsSync(join(home, '.local', 'bin', 'hang4r'))).toBe(false)
})
