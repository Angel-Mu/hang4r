import { test, expect, _electron as electron } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeScratchRepo, createProject } from './helpers'
import { writeShim } from '../src/main/services/cliInstall'

/**
 * REAL-agent check for `hang4r mcp`: the actual `claude` CLI consumes it through
 * the installed-style shim, against the built app on a temp userData dir. The MCP
 * config is handed over ONLY via --mcp-config (+ --strict-mcp-config), so no
 * user-level claude config is read or written by us.
 *
 *   HANG4R_REAL_E2E=1 npx playwright test e2e/real-mcp.spec.ts
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ELECTRON_BIN: string = require('electron')
const CLI = join(__dirname, '..', 'resources', 'ctl', 'hang4r-cli.js')

test.describe('real claude consumes hang4r mcp', () => {
  test.skip(process.env.HANG4R_REAL_E2E !== '1', 'set HANG4R_REAL_E2E=1 to run')
  test.setTimeout(240_000)

  test('claude -p lists sessions through the hang4r MCP shim', async () => {
    const userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'hang4r-real-mcp-')))
    const app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, HANG4R_FAKE_AGENT: '0', HANG4R_USER_DATA_DIR: userDataDir, HANG4R_QUIET_TEST: '1' }
    })
    try {
      const page = await app.firstWindow()
      await page.waitForSelector('.app', { timeout: 20_000 })
      await createProject(page, makeScratchRepo())
      await page.reload()
      await page.waitForSelector('.app')
      // two idle sessions (no prompt, so no model turn runs): the count claude must report
      for (const title of ['mcp probe one', 'mcp probe two']) {
        await page.evaluate(
          (t) =>
            window.hang4r.listProjects().then((ps) =>
              window.hang4r.createSession({
                projectId: ps[0].id,
                backend: 'claude',
                environment: 'local',
                permissionMode: 'default',
                title: t
              })
            ),
          title
        )
      }

      const binDir = join(userDataDir, 'bin')
      writeShim(binDir, ELECTRON_BIN, CLI)
      const cfg = join(userDataDir, 'mcp.json')
      writeFileSync(
        cfg,
        JSON.stringify({
          mcpServers: {
            hang4r: {
              command: join(binDir, 'hang4r'),
              args: ['mcp', '--as', 'claude-e2e'],
              env: { HANG4R_USER_DATA: userDataDir }
            }
          }
        })
      )
      const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(
          'claude',
          [
            '-p',
            '--model', 'haiku',
            '--mcp-config', cfg,
            '--strict-mcp-config',
            '--allowedTools', 'mcp__hang4r__*',
            '--no-session-persistence',
            '--output-format', 'stream-json',
            '--verbose',
            'Use hang4r to list sessions and report the count'
          ],
          { cwd: userDataDir, env: process.env }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => (stdout += d))
        child.stderr.on('data', (d) => (stderr += d))
        child.stdin.end()
        child.on('close', (code) => resolve({ code, stdout, stderr }))
      })
      console.log('CLAUDE EXIT', out.code, out.stderr.slice(0, 300))
      const lines = out.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const init = lines.find((l) => l.type === 'system' && l.subtype === 'init')
      console.log('MCP SERVERS', JSON.stringify(init?.mcp_servers))
      const toolUse = lines
        .filter((l) => l.type === 'assistant')
        .flatMap((l) => l.message.content)
        .find((c: { type: string; name?: string }) => c.type === 'tool_use' && /hang4r_list_sessions/.test(c.name ?? ''))
      const result = lines.find((l) => l.type === 'result')
      console.log('TOOL', JSON.stringify(toolUse))
      console.log('RESULT', result?.result)
      expect(init.mcp_servers.find((s: { name: string }) => s.name === 'hang4r')?.status).toBe('connected')
      expect(toolUse).toBeTruthy()
      expect(result.is_error).toBe(false)
      expect(result.result).toMatch(/\b(2|two)\b/i)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
