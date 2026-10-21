import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * `hang4r mcp` against the built app: the real script as a subprocess
 * (ELECTRON_RUN_AS_NODE, as Hermes / Claude Code / Codex would spawn it),
 * speaking newline-delimited JSON-RPC over stdio, fake agent behind it.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ELECTRON_BIN: string = require('electron')
const CLI = join(__dirname, '..', 'resources', 'ctl', 'hang4r-cli.js')

/* eslint-disable @typescript-eslint/no-explicit-any */
class McpClient {
  private child: ChildProcess
  private buf = ''
  private nextId = 1
  private pending = new Map<number, (m: any) => void>()
  frames: any[] = []
  stderr = ''
  stray = ''

  constructor(env: Record<string, string>, extraArgs: string[] = []) {
    this.child = spawn(ELECTRON_BIN, [CLI, 'mcp', ...extraArgs], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HANG4R_CTL_SOCK: '', HANG4R_CTL_TOKEN: '', ...env }
    })
    this.child.stderr!.on('data', (d) => (this.stderr += d))
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          this.stray += line + '\n' // anything on stdout that is not a frame breaks the protocol
          continue
        }
        this.frames.push(msg)
        this.pending.get(msg.id)?.(msg)
      }
    })
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async init(name = 'e2e'): Promise<any> {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name, version: '0' }
    })
    this.notify('notifications/initialized')
    return r
  }

  /** tools/call -> the structured payload plus the isError flag */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; s: any; raw: any }> {
    const r = await this.request('tools/call', { name, arguments: args })
    expect(r.error, JSON.stringify(r.error)).toBeUndefined()
    return { isError: r.result.isError, s: r.result.structuredContent, raw: r.result }
  }

  close(): Promise<number | null> {
    return new Promise((resolve) => {
      this.child.on('close', (code) => resolve(code))
      this.child.stdin!.end()
    })
  }
}

test.describe('hang4r mcp', () => {
  test.describe.configure({ mode: 'serial' })
  let launched: LaunchedApp
  let repo: string
  let project: string
  let env: Record<string, string>

  test.beforeAll(async () => {
    launched = await launchApp()
    repo = makeScratchRepo()
    project = basename(repo)
    await createProject(launched.page, repo)
    env = { HANG4R_USER_DATA: launched.userDataDir }
  })

  test.afterAll(async () => {
    await launched?.app.close().catch(() => {})
  })

  const NAMES = [
    'hang4r_status',
    'hang4r_list_projects',
    'hang4r_list_models',
    'hang4r_list_sessions',
    'hang4r_new_session',
    'hang4r_show_session',
    'hang4r_send',
    'hang4r_wait',
    'hang4r_interrupt',
    'hang4r_respond'
  ]

  test('initialize, ping, tools/list; stdout carries frames only', async () => {
    const c = new McpClient(env)
    const init = await c.init()
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.capabilities).toEqual({ tools: {} })
    expect(init.result.serverInfo.name).toBe('hang4r')
    expect((await c.request('ping')).result).toEqual({})

    const list = (await c.request('tools/list')).result.tools as any[]
    expect(list.map((t) => t.name)).toEqual(NAMES)
    for (const t of list) {
      expect(t.description.length, t.name).toBeGreaterThan(40)
      expect(t.inputSchema.type).toBe('object')
    }
    const byName = Object.fromEntries(list.map((t) => [t.name, t]))
    expect(Object.keys(byName.hang4r_new_session.inputSchema.properties).sort()).toEqual(
      ['backend', 'effort', 'env', 'model', 'permission_mode', 'project', 'prompt', 'title', 'wait'].sort()
    )
    expect(byName.hang4r_send.inputSchema.required).toEqual(['session_id', 'prompt'])
    expect(byName.hang4r_wait.description).toMatch(/needs-input/)
    expect(byName.hang4r_wait.description).toMatch(/hang4r_respond/)

    // protocol edges: unknown method, unknown tool, unparseable line
    expect((await c.request('nope')).error.code).toBe(-32601)
    expect((await c.request('tools/call', { name: 'hang4r_nope' })).error.code).toBe(-32602)
    const st = await c.tool('hang4r_status')
    expect(st.isError).toBe(false)
    expect(st.s.version).toBeTruthy()
    expect(st.s.userData).toBeTruthy()
    expect(JSON.parse(st.raw.content[0].text)).toEqual(st.s)
    expect(c.stray).toBe('')
    expect(c.stderr).toContain('hang4r mcp')
    expect(await c.close()).toBe(0)
  })

  test('new_session wait:true returns turn-complete; origin is the client name, or the --as name', async () => {
    const c = new McpClient(env)
    await c.init()
    const projects = await c.tool('hang4r_list_projects')
    expect(projects.s.projects.map((p: { name: string }) => p.name)).toContain(project)
    const r = await c.tool('hang4r_new_session', { project, env: 'local', prompt: 'hi there', wait: true })
    expect(r.isError).toBe(false)
    expect(r.s.reason).toBe('turn-complete')
    expect(r.s.result).toBeTruthy()
    expect(r.s.session.status).toBe('idle')
    expect(r.s.session.origin).toBe('cli:e2e') // initialize clientInfo.name
    const listed = await c.tool('hang4r_list_sessions')
    expect(listed.s.sessions.map((s: { id: string }) => s.id)).toContain(r.s.session.id)
    const shown = await c.tool('hang4r_show_session', { session_id: r.s.session.id })
    expect(shown.s.session.id).toBe(r.s.session.id)
    await c.close()

    const h = new McpClient(env, ['--as', 'hermes'])
    await h.init()
    const r2 = await h.tool('hang4r_new_session', { project, env: 'local', prompt: 'hello', wait: true })
    expect(r2.s.session.origin).toBe('cli:hermes')
    await h.close()
  })

  test('origin falls back to "mcp" without clientInfo, and the client name is scrubbed like --as', async () => {
    const bare = new McpClient(env)
    await bare.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    const r = await bare.tool('hang4r_new_session', { project, env: 'local', prompt: 'hi', wait: true })
    expect(r.s.session.origin).toBe('cli:mcp')
    await bare.close()

    const c = new McpClient(env)
    await c.init('claude-code')
    const r2 = await c.tool('hang4r_new_session', { project, env: 'local', prompt: 'hi', wait: true })
    expect(r2.s.session.origin).toBe('cli:claude-code')
    await c.close()

    const dirty = new McpClient(env)
    await dirty.init('Weird Client!/v2')
    const r3 = await dirty.tool('hang4r_new_session', { project, env: 'local', prompt: 'hi', wait: true })
    expect(r3.s.session.origin).toBe('cli:WeirdClientv2')
    await dirty.close()

    const as = new McpClient(env, ['--as', 'hermes'])
    await as.init('claude-code')
    const r4 = await as.tool('hang4r_new_session', { project, env: 'local', prompt: 'hi', wait: true })
    expect(r4.s.session.origin).toBe('cli:hermes') // --as overrides
    await as.close()
  })

  test('list_models mirrors `hang4r models`', async () => {
    const c = new McpClient(env)
    await c.init()
    const all = await c.tool('hang4r_list_models')
    expect(all.isError).toBe(false)
    const claude = await c.tool('hang4r_list_models', { backend: 'claude' })
    expect(claude.s.models.length).toBeGreaterThan(0)
    expect(claude.s.models.every((m: { backend: string }) => m.backend === 'claude')).toBe(true)
    expect(claude.s.models[0]).toEqual(
      expect.objectContaining({ backend: 'claude', id: expect.any(String), label: expect.any(String), default: expect.any(Boolean) })
    )
    const viaCli = await new Promise<{ models: unknown[] }>((resolve) => {
      const ch = spawn('node', [CLI, 'models', '--backend', 'claude', '--json'], {
        env: { ...process.env, HANG4R_CTL_SOCK: '', HANG4R_CTL_TOKEN: '', ...env }
      })
      let out = ''
      ch.stdout.on('data', (d) => (out += d))
      ch.on('close', () => resolve(JSON.parse(out)))
    })
    expect(claude.s.models).toEqual(viaCli.models)
    expect(all.s.models.length).toBeGreaterThanOrEqual(claude.s.models.length)
    expect((await c.tool('hang4r_list_models', { backend: 'gpt' })).isError).toBe(true)
    await c.close()
  })

  test('send while busy is a busy result, not an error; interrupt frees it', async () => {
    const c = new McpClient(env)
    await c.init()
    const made = await c.tool('hang4r_new_session', { project, env: 'local', prompt: 'slow turn 6000' })
    expect(made.isError).toBe(false)
    expect(made.s.session.status).toBe('running')
    const id = made.s.session.id
    const busy = await c.tool('hang4r_send', { session_id: id, prompt: 'too soon' })
    expect(busy.isError).toBe(false)
    expect(busy.s.reason).toBe('busy')
    expect(busy.s.session.status).toBe('running')
    const stopped = await c.tool('hang4r_interrupt', { session_id: id })
    expect(stopped.s.session.status).toBe('idle')
    const sent = await c.tool('hang4r_send', { session_id: id, prompt: 'after the stop', wait: true })
    expect(sent.s.reason).toBe('turn-complete')
    await c.close()
  })

  test('wait cap: timeout is a normal result carrying resumeAfter, and resuming returns the turn', async () => {
    const c = new McpClient({ ...env, HANG4R_MCP_WAIT_CAP_S: '1' })
    await c.init()
    const t0 = Date.now()
    const r = await c.tool('hang4r_new_session', { project, env: 'local', prompt: 'slow turn 3500', wait: true })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.isError).toBe(false)
    expect(r.s.reason).toBe('timeout')
    expect(typeof r.s.resumeAfter).toBe('number')
    expect(r.s.session.status).toBe('running')
    const id = r.s.session.id
    // a caller-supplied timeout above the cap is clamped to it
    const again = await c.tool('hang4r_wait', { session_id: id, after: r.s.resumeAfter, timeout_s: 600 })
    expect(again.isError).toBe(false)
    expect(again.s.reason === 'timeout' || again.s.reason === 'turn-complete').toBe(true)
    let done = again
    for (let i = 0; i < 6 && done.s.reason === 'timeout'; i++) {
      done = await c.tool('hang4r_wait', { session_id: id, after: done.s.resumeAfter })
    }
    expect(done.s.reason).toBe('turn-complete')
    expect(done.s.result).toContain('slow turn')
    await c.close()
  })

  test('needs-input is a normal result; respond completes the turn', async () => {
    const c = new McpClient(env)
    await c.init()
    const made = await c.tool('hang4r_new_session', { project, env: 'local', prompt: 'ask permission', wait: true })
    expect(made.isError).toBe(false)
    expect(made.s.reason).toBe('needs-input')
    expect(made.s.hint).toMatch(/hang4r_respond/)
    const pending = made.s.session.pending
    expect(pending.kind).toBe('permission')
    const id = made.s.session.id
    const bad = await c.tool('hang4r_respond', { session_id: id, request_id: pending.requestId, decision: 'maybe' })
    expect(bad.isError).toBe(true)
    expect(bad.s.code).toBe('usage')
    const ok = await c.tool('hang4r_respond', {
      session_id: id,
      request_id: pending.requestId,
      decision: 'allow',
      wait: true
    })
    expect(ok.isError).toBe(false)
    expect(ok.s.reason).toBe('turn-complete')
    const dead = await c.tool('hang4r_respond', { session_id: id, request_id: pending.requestId, decision: 'allow' })
    expect(dead.isError).toBe(true)
    expect(dead.s).toMatchObject({ code: 'not-found', exitCode: 7 })
    await c.close()
  })

  test('errors map to isError with code, message and exit code', async () => {
    const c = new McpClient(env)
    await c.init()
    const missing = await c.tool('hang4r_show_session', { session_id: 'no-such-session' })
    expect(missing.isError).toBe(true)
    expect(missing.s).toMatchObject({ code: 'not-found', exitCode: 7 })
    expect(missing.s.message).toBeTruthy()
    const noArg = await c.tool('hang4r_send', { session_id: 'x' })
    expect(noArg.isError).toBe(true)
    expect(noArg.s).toMatchObject({ code: 'usage', exitCode: 2 })
    const badEnum = await c.tool('hang4r_new_session', { project, backend: 'gpt' })
    expect(badEnum.s.code).toBe('usage')
    const noProject = await c.tool('hang4r_new_session', { project: 'nope-not-a-project' })
    expect(noProject.isError).toBe(true)
    expect(noProject.s.code).toBe('not-found')
    const errored = await c.tool('hang4r_new_session', { project, env: 'local', prompt: 'trigger error', wait: true })
    // an errored turn is an error result, with the session and message attached
    expect(errored.isError).toBe(true)
    expect(errored.s).toMatchObject({ code: 'turn-error', exitCode: 6, reason: 'error' })
    expect(errored.s.session.id).toBeTruthy()
    await c.close()
  })

  test('app unreachable: a tool error, and the server stays up for the next call', async () => {
    const c = new McpClient({ HANG4R_USER_DATA: join(launched.userDataDir, 'nowhere') })
    await c.init()
    const r = await c.tool('hang4r_status')
    expect(r.isError).toBe(true)
    expect(r.s).toMatchObject({ code: 'unreachable', exitCode: 10 })
    expect((await c.request('ping')).result).toEqual({})
    await c.close()
  })
})

test('wait:true: the app dies after the send succeeded, the error still carries session id and after', async () => {
  const l = await launchApp()
  const c = new McpClient({ HANG4R_USER_DATA: l.userDataDir })
  try {
    const repo = makeScratchRepo()
    await createProject(l.page, repo)
    await c.init()
    const call = c.tool('hang4r_new_session', {
      project: basename(repo),
      env: 'local',
      prompt: 'slow turn 8000',
      wait: true
    })
    // the send has landed once the session is running; the wait call is then in flight
    await expect
      .poll(async () => (await l.page.evaluate(() => window.hang4r.listSessions())).map((s) => s.status), {
        timeout: 10_000
      })
      .toContain('running')
    const sid = (await l.page.evaluate(() => window.hang4r.listSessions()))[0].id
    await l.app.close() // quit: the socket under the wait goes away
    const r = await call
    expect(r.isError).toBe(true)
    expect(r.s.code).toBeTruthy()
    expect(r.s.sent).toBe(true)
    expect(r.s.session.id).toBe(sid)
    expect(typeof r.s.after).toBe('number')
    expect(r.s.hint).toMatch(/Do NOT send again/)
  } finally {
    await c.close()
    await l.app.close().catch(() => {})
  }
})
