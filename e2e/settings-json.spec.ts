import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'
import { stripJsonComments } from '../src/shared/jsonc'

/** Seed a hang4r.db `settings` table by running better-sqlite3 under Electron's
 *  own Node (ELECTRON_RUN_AS_NODE) so the native module's ABI matches. */
function seedSettingsDb(dbPath: string, rows: Record<string, string>): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronPath: string = require('electron')
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(process.env.HANG4R_DB);
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const ins = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [k,v] of Object.entries(JSON.parse(process.env.HANG4R_ROWS))) ins.run(k, v);
    db.close();
  `
  execFileSync(electronPath, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HANG4R_DB: dbPath, HANG4R_ROWS: JSON.stringify(rows) }
  })
}

/**
 * File-backed settings (VS Code style): an app file (~/.hang4r/settings.json,
 * nested under the throwaway userData dir in tests) plus per-workspace override
 * files (<project>/.hang4r/settings.json). These exercise the three load-bearing
 * behaviours: workspace-over-app precedence through the real resolution IPC,
 * one-time SQLite→file migration on first launch, and live-reload of external
 * hand-edits.
 */
test.describe('file-backed settings', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  test('workspace settings.json overrides the app file', async () => {
    launched = await launchApp()
    const { page, userDataDir } = launched
    const repo = makeScratchRepo()
    const { id } = await createProject(page, repo)

    // app-global defaults
    writeFileSync(
      join(userDataDir, '.hang4r', 'settings.json'),
      JSON.stringify({ worktreeDir: 'APP_WT', terminalShell: '/bin/app-sh' }, null, 2)
    )
    // per-workspace overrides live in the repo (versionable)
    mkdirSync(join(repo, '.hang4r'), { recursive: true })
    writeFileSync(
      join(repo, '.hang4r', 'settings.json'),
      JSON.stringify(
        {
          worktreeDir: 'WS_WT',
          terminalShell: '/bin/ws-sh',
          devProcesses: [{ name: 'web', command: 'echo hi' }]
        },
        null,
        2
      )
    )

    // resolve through the same getSetting IPC every consumer uses
    const resolved = await page.evaluate(async (projectId) => {
      return {
        appWt: await window.hang4r.getSetting('worktreeDir'),
        wsWt: await window.hang4r.getSetting(`worktreeDir:${projectId}`),
        appShell: await window.hang4r.getSetting('terminalShell'),
        wsShell: await window.hang4r.getSetting(`terminalShell:${projectId}`),
        devProcs: await window.hang4r.getSetting(`devProcesses:${projectId}`)
      }
    }, id)

    expect(resolved.appWt).toBe('APP_WT')
    expect(resolved.wsWt).toBe('WS_WT') // workspace beats app
    expect(resolved.appShell).toBe('/bin/app-sh')
    expect(resolved.wsShell).toBe('/bin/ws-sh')
    expect(JSON.parse(resolved.devProcs!)).toEqual([{ name: 'web', command: 'echo hi' }])
  })

  test('first launch migrates SQLite user settings into the app file', async () => {
    // Seed a hang4r.db with user-setting rows BEFORE the app ever runs, with no
    // app settings file present — first launch must export them into the file.
    const userDataDir = mkdtempSync(join(tmpdir(), 'hang4r-e2e-mig-'))
    const appFile = join(userDataDir, '.hang4r', 'settings.json')
    seedSettingsDb(join(userDataDir, 'hang4r.db'), {
      theme: 'light',
      chatFontSize: '19',
      claudeBinaryPath: '/opt/claude'
    })

    expect(existsSync(appFile)).toBe(false)

    launched = await launchApp({ userDataDir })

    // migration runs synchronously at service construction (app-ready)
    const parsed = JSON.parse(readFileSync(appFile, 'utf8'))
    expect(parsed.theme).toBe('light')
    expect(parsed.chatFontSize).toBe(19) // coerced back to a number in the file
    expect(parsed.binaries.claude).toBe('/opt/claude') // nested under binaries.*
    // the original DB rows are kept as fallback — nothing destroyed
    const resolved = await launched.page.evaluate(() => window.hang4r.getSetting('theme'))
    expect(resolved).toBe('light')
  })

  test('editing the app file on disk live-updates the UI (chat font)', async () => {
    launched = await launchApp()
    const { page, userDataDir } = launched
    await page.waitForSelector('.app')

    // hand-edit the app file externally — the fs.watch broadcast should re-apply
    writeFileSync(
      join(userDataDir, '.hang4r', 'settings.json'),
      JSON.stringify({ chatFontSize: 22 }, null, 2)
    )

    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue('--chat-font')
          ),
        { timeout: 8000 }
      )
      .toBe('22px')
  })

  test('structured save REFUSES to clobber a malformed settings file (QA hunt #11)', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    const { id } = await createProject(page, repo)

    // a hand-edited workspace file with a trailing comma — JSONC comments are
    // tolerated, but this is NOT valid JSON; a write starting from {} used to
    // silently destroy devProcesses (the data-loss bug)
    mkdirSync(join(repo, '.hang4r'), { recursive: true })
    const file = join(repo, '.hang4r', 'settings.json')
    const malformed =
      '{\n  "devProcesses": [{ "name": "dev", "command": "npm run dev" }],\n  "worktreeDir": "wt-old",\n}\n'
    writeFileSync(file, malformed)

    // the structured save (what the Worktrees tab fires) must reject…
    const err = await page.evaluate((pid) =>
      window.hang4r
        .setSetting(`worktreeDir:${pid}`, 'wt-new')
        .then(() => null)
        .catch((e: Error) => String(e.message ?? e)),
      id
    )
    expect(err).toContain('Refusing to save')

    // …and the file must be byte-identical — devProcesses intact
    expect(readFileSync(file, 'utf8')).toBe(malformed)
  })

  test('a structured save preserves the user’s comments in the workspace file', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    const { id } = await createProject(page, repo)

    // a hand-authored workspace file: comments the user is ENCOURAGED to keep,
    // alongside real values that a structured save must not disturb.
    mkdirSync(join(repo, '.hang4r'), { recursive: true })
    const file = join(repo, '.hang4r', 'settings.json')
    const seeded = `{
  // Per-workspace hang4r settings for THIS repo.
  "worktreeDir": "wt-old", // where worktrees land
  // dev processes to auto-start
  "devProcesses": [{ "name": "web", "command": "npm run dev" }]
}
`
    writeFileSync(file, seeded)

    // the exact IPC the Worktrees tab per-project field fires
    await page.evaluate((pid) => window.hang4r.setSetting(`worktreeDir:${pid}`, 'wt-new'), id)

    const after = readFileSync(file, 'utf8')
    // only the targeted value changed; the other setting is intact
    expect(JSON.parse(stripJsonComments(after))).toEqual({
      worktreeDir: 'wt-new',
      devProcesses: [{ name: 'web', command: 'npm run dev' }]
    })
    // every whole-line comment from the seed survives verbatim
    for (const line of seeded.split('\n').filter((l) => l.trim().startsWith('//'))) {
      expect(after).toContain(line.trim())
    }
    // the inline comment beside the CHANGED value survives too (only the value moved)
    expect(after).toContain('// where worktrees land')
    // and it resolves through the same getSetting IPC every consumer uses
    const resolved = await page.evaluate((pid) => window.hang4r.getSetting(`worktreeDir:${pid}`), id)
    expect(resolved).toBe('wt-new')
  })
})
