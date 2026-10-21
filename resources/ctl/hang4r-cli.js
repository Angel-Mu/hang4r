#!/usr/bin/env node
'use strict'
/*
 * hang4r browser — a cmux-style CLI that lets ANY agent hang4r spawns (claude /
 * codex / cursor subprocesses, terminals, setup scripts) drive and ASSERT
 * against the session's embedded browser pane: navigate, read the DOM, click,
 * type, screenshot, check console errors.
 *
 * Plain Node.js, ZERO npm dependencies. It talks to the hang4r main process over
 * a unix socket (newline-delimited JSON, one command per connection):
 *   request : { token, sessionId, cmd, args }
 *   response: { ok: true, result } | { ok: false, error }
 *
 * It also drives hang4r itself from outside (`hang4r sessions new|send|wait|…`):
 * create sessions, steer them, answer their permission prompts. Those commands
 * need no HANG4R_SESSION_ID; they discover the running app (see discover()).
 *
 * Environment (hang4r injects these into every session's processes):
 *   HANG4R_CTL_SOCK    absolute path to the control socket
 *   HANG4R_CTL_TOKEN   auth token (falls back to `ctl.token` next to the socket)
 *   HANG4R_SESSION_ID  the session this process belongs to (the browser it drives)
 */

const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')

const HELP = `hang4r browser — drive & assert against this session's embedded browser pane.

USAGE
  hang4r browser <command> [args] [--tab <id>]

COMMANDS
  tabs                          List this session's browser tabs (id, title, url, active).
  goto <url>                    Navigate the tab to <url>; waits for load. Opens a
                                Browser tab in hang4r if the session has none.
  snapshot [--selector <css>]   Accessibility-style outline of the page. Interactive
           [--compact]          elements end with [ref=eN]. --selector scopes the walk
                                (default: body). --compact drops non-heading prose.
  click <eN|css>                Click an element by its snapshot ref (eN) or a CSS selector.
  type <eN|css> <text>          Focus an element and set its value (fires input+change so
                                React/Vue controlled inputs actually update).
  select <eN|css> <value>       Choose an <option> by value on a <select> (fires change).
  press <key>                   Dispatch a key on the focused element. Keys: Enter, Escape,
                                Tab, ArrowUp/Down/Left/Right, or any single character.
  scroll <dy> [dx]              Scroll the window (or --selector element) by dy/dx pixels.
  get <text|url|title>          Print the page text (--selector to scope), URL, or title.
  eval <js>                     Run JS in the page; prints the result as JSON. The
                                assertion workhorse (e.g. eval "document.title").
  wait [--selector <css>]       Poll until a selector matches or --text appears in the
       [--text <s>]             page. --timeout <ms> (default 10000).
  screenshot [<path>]           Capture the tab to a PNG; prints the absolute path.
  console [--clear]             Print captured console messages (last 200). --clear empties.

FLAGS
  --tab <id>       Target a specific tab id (from \`tabs\`). Default: the active tab.
  --selector <css> Scope for snapshot / get text / wait / scroll.
  --text <s>       Text to wait for (wait).
  --timeout <ms>   Timeout for wait (default 10000).
  --compact        snapshot: interactive elements + headings only.
  --clear          console: clear the buffer after printing.

THE REF WORKFLOW
  Refs (e1, e2, …) are assigned to INTERACTIVE elements by \`snapshot\` and stored on
  the page. They REGENERATE on every snapshot — always snapshot right before you click
  or type, and use the eN from THAT snapshot. A stale/unknown ref is an error telling
  you to re-run snapshot. You can always target a CSS selector instead of a ref.

CONTROLLED INPUTS
  \`type\` and \`select\` set the value through the native setter and dispatch proper
  input/change events, so React/Vue-controlled inputs register the change. You do not
  need to press keys to "commit" a typed value.

END-TO-END EXAMPLE
  hang4r browser goto http://localhost:3000
  hang4r browser snapshot                       # find the ref of the field & button
  hang4r browser type e3 "hello world"
  hang4r browser click e5
  hang4r browser wait --text "Saved"
  hang4r browser eval "document.querySelector('.status').textContent"
  hang4r browser console                        # check for errors the click produced
  hang4r browser screenshot /tmp/after.png

NOTES
  - Refs regenerate on every snapshot (see above).
  - Every command targets the ACTIVE tab unless you pass --tab <id>.
  - The session must have a Browser tab open in hang4r (goto opens one if the tile is
    on screen). If no tile is open for the session there is no webview to drive.
  - SSH sessions are unsupported: the remote host can't reach this local socket.
`

function fail(msg) {
  process.stderr.write(String(msg).replace(/\n?$/, '\n'))
  process.exit(1)
}

/** Parse argv into { cmd, positionals, flags }. Flags: --name value, or --name (boolean). */
function parseArgs(argv) {
  const positionals = []
  const flags = {}
  const BOOL = new Set(['compact', 'clear'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (BOOL.has(name)) {
        flags[name] = true
      } else {
        flags[name] = argv[++i]
      }
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

/** Build the { cmd, args } payload for a given subcommand + parsed args. */
function buildCommand(cmd, positionals, flags) {
  const tabId = flags.tab
  const withTab = (o) => (tabId !== undefined ? { ...o, tabId } : o)
  switch (cmd) {
    case 'tabs':
      return { cmd: 'tabs', args: {} }
    case 'goto': {
      const url = positionals[0]
      if (!url) fail('goto needs a URL: hang4r browser goto <url>')
      return { cmd: 'goto', args: withTab({ url }) }
    }
    case 'snapshot':
      return {
        cmd: 'snapshot',
        args: withTab({ selector: flags.selector, compact: !!flags.compact })
      }
    case 'click': {
      const target = positionals[0]
      if (!target) fail('click needs a target: hang4r browser click <eN|css>')
      return { cmd: 'click', args: withTab({ target }) }
    }
    case 'type': {
      const target = positionals[0]
      if (!target) fail('type needs a target: hang4r browser type <eN|css> <text>')
      // remaining positionals (or --text) form the text
      const text = flags.text !== undefined ? flags.text : positionals.slice(1).join(' ')
      return { cmd: 'type', args: withTab({ target, text }) }
    }
    case 'select': {
      const target = positionals[0]
      const value = flags.value !== undefined ? flags.value : positionals[1]
      if (!target || value === undefined)
        fail('select needs a target and value: hang4r browser select <eN|css> <value>')
      return { cmd: 'select', args: withTab({ target, value }) }
    }
    case 'press': {
      const key = positionals[0]
      if (!key) fail('press needs a key: hang4r browser press <key>')
      return { cmd: 'press', args: withTab({ key }) }
    }
    case 'scroll': {
      const dy = flags.dy !== undefined ? Number(flags.dy) : Number(positionals[0] ?? 0)
      const dx = flags.dx !== undefined ? Number(flags.dx) : Number(positionals[1] ?? 0)
      return { cmd: 'scroll', args: withTab({ dy, dx, selector: flags.selector }) }
    }
    case 'get': {
      const what = positionals[0]
      if (!['text', 'url', 'title'].includes(what)) fail('get needs one of: text | url | title')
      return { cmd: 'get', args: withTab({ what, selector: flags.selector }) }
    }
    case 'eval': {
      const js = flags.js !== undefined ? flags.js : positionals.join(' ')
      if (!js) fail('eval needs JS: hang4r browser eval "<js>"')
      return { cmd: 'eval', args: withTab({ js }) }
    }
    case 'wait': {
      const timeoutMs = flags.timeout !== undefined ? Number(flags.timeout) : undefined
      return {
        cmd: 'wait',
        args: withTab({ selector: flags.selector, text: flags.text, timeoutMs })
      }
    }
    case 'screenshot':
      return { cmd: 'screenshot', args: withTab({ path: positionals[0] }) }
    case 'console':
      return { cmd: 'console', args: withTab({ clear: !!flags.clear }) }
    default:
      fail(`Unknown command: ${cmd}\nRun \`hang4r browser --help\`.`)
  }
}

/** Format a successful result for humans (or raw JSON for eval). */
function formatResult(cmd, result) {
  switch (cmd) {
    case 'tabs': {
      const tabs = result.tabs || []
      if (!tabs.length) return '(no browser tabs open in this session)'
      return tabs
        .map((t) =>
          `${t.active ? '*' : ' '} ${t.id}  ${t.title || '(untitled)'}  ${t.url || ''}`.trimEnd()
        )
        .join('\n')
    }
    case 'goto':
      return result.failed
        ? `Loaded ${result.url} with an error: ${result.failed.errorCode} ${result.failed.errorDescription}`
        : `${result.title || '(untitled)'}\n${result.url}`
    case 'snapshot':
      return result.text
    case 'get':
      return result.value
    case 'eval':
      // raw JSON — this is the assertion output agents parse
      return result.json
    case 'wait':
      return `matched after ${result.elapsedMs}ms`
    case 'screenshot':
      return result.path
    case 'console': {
      const entries = result.entries || []
      if (!entries.length) return '(no console messages)'
      return entries.map((e) => `[${e.level}] ${e.message}`).join('\n')
    }
    case 'click':
    case 'type':
    case 'select':
    case 'press':
    case 'scroll':
      return 'ok'
    default:
      return JSON.stringify(result)
  }
}

function resolveToken(sockPath) {
  if (process.env.HANG4R_CTL_TOKEN) return process.env.HANG4R_CTL_TOKEN
  // fall back to the token file hang4r writes next to the socket (chmod 600),
  // so a process that only knows the socket path can still authenticate
  try {
    const tokenFile = path.join(path.dirname(sockPath), 'ctl.token')
    return fs.readFileSync(tokenFile, 'utf8').trim()
  } catch {
    return null
  }
}

function send(sockPath, token, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath)
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(JSON.stringify(payload) + '\n')
    })
    socket.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl !== -1) {
        socket.end()
        try {
          resolve(JSON.parse(buf.slice(0, nl)))
        } catch (e) {
          reject(new Error(`Bad response from hang4r: ${String(e)}`))
        }
      }
    })
    socket.on('error', (e) =>
      reject(
        new Error(
          `Can't reach hang4r at ${sockPath} (${e.code || e.message}). Is the hang4r app running?`
        )
      )
    )
    socket.on('close', () => {
      if (!buf.includes('\n')) reject(new Error('hang4r closed the connection with no response.'))
    })
  })
}

/* ======================================================================
 * App control: `hang4r status|projects|models|sessions …`
 * ====================================================================== */

const APP_HELP = `hang4r — drive hang4r from outside, and its embedded browser from inside a session.

USAGE
  hang4r status                          Is hang4r running? (version, userData)
  hang4r projects                        Projects already added in hang4r
  hang4r models [--backend B]            Models per backend
  hang4r sessions [--limit N]            Sessions, newest first (default 50)
  hang4r sessions new [prompt|-]         Create a session (no prompt = idle session)
  hang4r sessions show <id>              One session: status, pending request, last result, recent events
  hang4r sessions send <id> <prompt|->   Follow-up turn (exit 5 if the session is busy)
  hang4r sessions wait <id>              Block until the running turn ends or needs input
  hang4r sessions interrupt <id>         Stop the running turn
  hang4r sessions respond <id> <requestId> allow|deny
  hang4r sessions respond <id> <requestId> --option <id> [--option <id> ...]
  hang4r sessions archive <id>
  hang4r browser <command>               Drive this session's browser pane (hang4r browser --help)

FLAGS (every command)
  --json         Machine output (also the default when stdout is not a terminal)
  --as <name>    Who is calling; shown in hang4r as "via <name>". Display only.
  --launch       Start hang4r if it is not running (or HANG4R_AUTO_LAUNCH=1), wait up to 30s

sessions new
  --project P            Project id, exact name or absolute path of a project already in hang4r.
                         Omitted: the project containing the current directory.
  --backend claude|codex|cursor      (default claude)
  --model M   --effort low|medium|high|xhigh|max   --title T
  --env local|worktree   Omitted: the same default as hang4r's Start-agent dialog
  --permission-mode default|acceptEdits|plan|bypassPermissions   Any mode is allowed.
  --prompt-file F        Read the prompt from a file
  --wait [--timeout S]   Block until the first turn ends (see wait)

sessions send / respond / wait
  --wait                 send, respond: block as wait does
  --timeout S            Seconds to block (default 600, max 3600, 0 = check once). Never stops the agent.
  --after SEQ            wait: only a turn that finished after transcript position SEQ counts
                         (new/send/respond print it as "after"; --wait does this for you)
  --rebuild-worktree     send: recreate the session's worktree if it was removed

HOW WAIT DECIDES
  turn-complete  the turn you started finished           exit 0
  needs-input    blocked on a permission/question        exit 3  (see session.pending)
  timeout        --timeout elapsed, still running        exit 4
  error          the turn failed, or the agent died      exit 6
  idle           wait with nothing running (no result)   exit 0
  A turn-complete from before your send never satisfies the wait.

EXIT CODES
  0 ok   1 internal error   2 usage error   3 needs input   4 timeout   5 session busy
  6 turn ended in error   7 not found (project, session, request; also archived)
  9 worktree missing (use --rebuild-worktree)   10 hang4r not reachable   11 auth failed

DISCOVERY
  HANG4R_CTL_SOCK (+ HANG4R_CTL_TOKEN), else HANG4R_USER_DATA, else
  ~/Library/Application Support/hang4r. The token is read from ctl.token on every call.
`

const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  needsInput: 3,
  timeout: 4,
  busy: 5,
  turnError: 6,
  notFound: 7,
  worktreeMissing: 9,
  unreachable: 10,
  auth: 11
}

const CODE_TO_EXIT = {
  usage: EXIT.usage,
  'not-found': EXIT.notFound,
  busy: EXIT.busy,
  'worktree-missing': EXIT.worktreeMissing,
  internal: EXIT.internal,
  auth: EXIT.auth,
  unreachable: EXIT.unreachable
}

/** an error that carries the exit code and machine code to report */
class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const APP_COMMANDS = new Set(['status', 'projects', 'models', 'sessions'])
const BOOL_FLAGS = new Set(['json', 'launch', 'wait', 'rebuild-worktree', 'help'])
const VALUE_FLAGS = new Set([
  'as',
  'project',
  'backend',
  'model',
  'effort',
  'env',
  'permission-mode',
  'title',
  'timeout',
  'after',
  'limit',
  'prompt-file',
  'option'
])

/** Strict parser for the app commands (the browser parser tolerates unknown flags). */
function parseAppArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-') {
      positionals.push(a)
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
      if (BOOL_FLAGS.has(name)) {
        flags[name] = true
      } else if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : a.slice(eq + 1)
        if (value === undefined) throw new CliError('usage', `--${name} needs a value`)
        if (name === 'option') (flags.option = flags.option || []).push(value)
        else flags[name] = value
      } else {
        throw new CliError('usage', `Unknown flag --${name}. Run \`hang4r --help\`.`)
      }
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

/** Where is the running app? env first (inside a session), then HANG4R_USER_DATA, then the default. */
function discover(env, platform, home) {
  const e = env || process.env
  if (e.HANG4R_CTL_SOCK)
    return { sockPath: e.HANG4R_CTL_SOCK, envToken: e.HANG4R_CTL_TOKEN || null }
  const plat = platform || process.platform
  let dir = e.HANG4R_USER_DATA
  if (!dir) {
    if (plat !== 'darwin') {
      throw new CliError(
        'unreachable',
        'Discovery is macOS-only for now; set HANG4R_USER_DATA to the app data directory.'
      )
    }
    dir = path.join(
      home || require('node:os').homedir(),
      'Library',
      'Application Support',
      'hang4r'
    )
  }
  return { sockPath: path.join(dir, 'ctl.sock'), envToken: null }
}

/** The token rotates every app boot, so it is read on EVERY call; an env value (set in a session) wins. */
function readToken(sockPath, envToken) {
  if (envToken) return envToken
  try {
    return fs.readFileSync(path.join(path.dirname(sockPath), 'ctl.token'), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** Poll until `probe()` resolves true or `timeoutMs` passes. Exported for the --launch unit test. */
async function pollUntil(probe, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

function canConnect(sockPath) {
  return new Promise((resolve) => {
    const s = net.createConnection(sockPath)
    s.on('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.on('error', () => resolve(false))
  })
}

/** Fail fast when the app is down; with --launch start it and wait for the socket. */
async function ensureRunning(sockPath, launch) {
  if (await canConnect(sockPath)) return
  if (!launch) {
    throw new CliError('unreachable', 'hang4r is not running. Start it, or pass --launch.')
  }
  // Test seam only: the override goes to /bin/sh -c, so a production CLI must never
  // honor an env var anyone upstream of it could set. Only the fake-agent e2e env does.
  const cmd = process.env.HANG4R_FAKE_AGENT === '1' ? process.env.HANG4R_LAUNCH_CMD : undefined
  const child = cmd
    ? require('node:child_process').spawn('/bin/sh', ['-c', cmd], {
        detached: true,
        stdio: 'ignore'
      })
    : require('node:child_process').spawn('open', ['-a', 'hang4r'], {
        detached: true,
        stdio: 'ignore'
      })
  child.on('error', () => {})
  child.unref()
  const wait = Number(process.env.HANG4R_LAUNCH_TIMEOUT_MS) || 30000
  const up = await pollUntil(() => canConnect(sockPath), wait, 250)
  if (!up)
    throw new CliError('unreachable', `hang4r did not start within ${Math.round(wait / 1000)}s.`)
}

/** One request, one response. A wait holds the connection open; a drop mid-request means the app quit. */
function appRequest(sockPath, token, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath)
    let buf = ''
    let answered = false
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ token, ...payload }) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      answered = true
      socket.end()
      try {
        resolve(JSON.parse(buf.slice(0, nl)))
      } catch (e) {
        reject(new CliError('internal', `Bad response from hang4r: ${String(e)}`))
      }
    })
    socket.on('error', (e) =>
      reject(new CliError('unreachable', `Can't reach hang4r (${e.code || e.message}).`))
    )
    socket.on('close', () => {
      if (!answered)
        reject(new CliError('unreachable', 'hang4r went away before answering (app-quit).'))
    })
  })
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let out = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (out += c))
    process.stdin.on('end', () => resolve(out))
    process.stdin.on('error', reject)
  })
}

/** prompt text from a positional list, `-` (stdin) or --prompt-file */
async function promptFrom(words, flags) {
  if (flags['prompt-file']) {
    try {
      return fs.readFileSync(flags['prompt-file'], 'utf8')
    } catch (e) {
      throw new CliError('usage', `Can't read --prompt-file: ${e.message}`)
    }
  }
  if (words.length === 1 && words[0] === '-') return readStdin()
  return words.join(' ')
}

function numFlag(flags, name) {
  if (flags[name] === undefined) return undefined
  const n = Number(flags[name])
  if (!Number.isFinite(n) || n < 0)
    throw new CliError('usage', `--${name} must be a non-negative number`)
  return n
}

/** Turn argv into { cmd, args } for the app namespace. */
async function buildAppCommand(argv) {
  const { positionals, flags } = parseAppArgs(argv)
  const [top, sub, ...rest] = positionals
  const common = { timeout: numFlag(flags, 'timeout') }
  if (top === 'status' || top === 'projects') return { flags, cmd: `app.${top}`, args: {} }
  if (top === 'models') return { flags, cmd: 'app.models', args: { backend: flags.backend } }
  // top === 'sessions'
  if (!sub) return { flags, cmd: 'app.sessions', args: { limit: numFlag(flags, 'limit') } }
  const need = (n, usage) => {
    if (rest.length < n) throw new CliError('usage', `usage: hang4r sessions ${usage}`)
  }
  switch (sub) {
    case 'new': {
      const prompt = await promptFrom(rest, flags)
      return {
        flags,
        cmd: 'app.new',
        args: {
          prompt: prompt || undefined,
          project: flags.project,
          cwd: process.cwd(),
          backend: flags.backend,
          model: flags.model,
          effort: flags.effort,
          env: flags.env,
          permissionMode: flags['permission-mode'],
          title: flags.title,
          wait: !!flags.wait,
          ...common
        }
      }
    }
    case 'show':
      need(1, 'show <id>')
      return { flags, cmd: 'app.show', args: { sessionId: rest[0] } }
    case 'send': {
      need(2, 'send <id> <prompt|->')
      const prompt = await promptFrom(rest.slice(1), flags)
      return {
        flags,
        cmd: 'app.send',
        args: {
          sessionId: rest[0],
          prompt,
          wait: !!flags.wait,
          rebuildWorktree: !!flags['rebuild-worktree'],
          ...common
        }
      }
    }
    case 'wait':
      need(1, 'wait <id>')
      return {
        flags,
        cmd: 'app.wait',
        args: { sessionId: rest[0], after: numFlag(flags, 'after'), ...common }
      }
    case 'interrupt':
      need(1, 'interrupt <id>')
      return { flags, cmd: 'app.interrupt', args: { sessionId: rest[0] } }
    case 'archive':
      need(1, 'archive <id>')
      return { flags, cmd: 'app.archive', args: { sessionId: rest[0] } }
    case 'respond':
      need(2, 'respond <id> <requestId> allow|deny | --option <id>')
      return {
        flags,
        cmd: 'app.respond',
        args: {
          sessionId: rest[0],
          requestId: rest[1],
          decision: rest[2],
          options: flags.option,
          wait: !!flags.wait,
          ...common
        }
      }
    default:
      throw new CliError('usage', `Unknown sessions command: ${sub}. Run \`hang4r --help\`.`)
  }
}

/** exit code for a successful response (waits report how they ended) */
function exitFor(result) {
  if (!result || typeof result.reason !== 'string') return EXIT.ok
  switch (result.reason) {
    case 'turn-complete':
      return result.isError ? EXIT.turnError : EXIT.ok
    case 'idle':
      return EXIT.ok
    case 'needs-input':
      return EXIT.needsInput
    case 'timeout':
      return EXIT.timeout
    case 'archived':
      return EXIT.notFound
    default:
      return EXIT.turnError
  }
}

function humanSession(s) {
  const bits = [s.id, s.status, s.backend, s.title]
  if (s.origin) bits.push(`via ${s.origin}`)
  return bits.join('  ')
}

/** terse text for a terminal; scripts get JSON */
function humanOutput(cmd, r) {
  switch (cmd) {
    case 'app.status':
      return `hang4r ${r.version} running (userData ${r.userData})`
    case 'app.projects':
      return (
        r.projects
          .map((p) => `${p.id}  ${p.name}  ${p.path}  (${p.sessionCount} sessions)`)
          .join('\n') || '(no projects)'
      )
    case 'app.models':
      return r.models
        .map((m) => `${m.backend}  ${m.id || '(default)'}  ${m.label}${m.default ? '  *' : ''}`)
        .join('\n')
    case 'app.sessions':
      return r.sessions.map(humanSession).join('\n') || '(no sessions)'
    case 'app.archive':
      return `${r.id} archived`
    default: {
      if (typeof r.reason === 'string') {
        const lines = [`${r.reason}: ${humanSession(r.session)}`]
        if (r.result) lines.push(r.result)
        if (r.errorMessage) lines.push(`error: ${r.errorMessage}`)
        if (r.session.pending)
          lines.push(
            `pending ${r.session.pending.kind} ${r.session.pending.requestId}: ${r.session.pending.summary || ''}`
          )
        return lines.join('\n')
      }
      const lines = [humanSession(r.session)]
      if (r.after !== undefined) lines.push(`after ${r.after}`)
      if (r.session.pending)
        lines.push(
          `pending ${r.session.pending.kind} ${r.session.pending.requestId}: ${r.session.pending.summary || ''}`
        )
      if (r.session.lastResult) lines.push(r.session.lastResult)
      for (const e of r.events || []) lines.push(`[${e.role}] ${e.text}`)
      return lines.join('\n')
    }
  }
}

function emitFailure(err, json) {
  const code = err && err.code && CODE_TO_EXIT[err.code] !== undefined ? err.code : 'internal'
  const message = err && err.message ? err.message : String(err)
  if (json) process.stderr.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n')
  else process.stderr.write(`hang4r: ${message}\n`)
  return CODE_TO_EXIT[code]
}

async function runApp(argv) {
  const wantJson = argv.includes('--json') || !process.stdout.isTTY
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(APP_HELP)
      return EXIT.ok
    }
    const { flags, cmd, args } = await buildAppCommand(argv)
    const json = !!flags.json || !process.stdout.isTTY
    const { sockPath, envToken } = discover()
    await ensureRunning(sockPath, !!flags.launch || process.env.HANG4R_AUTO_LAUNCH === '1')
    const token = readToken(sockPath, envToken)
    if (!token)
      throw new CliError('auth', 'No auth token: ctl.token is missing next to the socket.')
    const res = await appRequest(sockPath, token, { cmd, args, caller: flags.as })
    if (!res || res.ok !== true) {
      const code = res && res.code ? res.code : 'internal'
      throw new CliError(code, res && res.error ? res.error : 'Command failed.')
    }
    const result = res.result || {}
    process.stdout.write(
      (json ? JSON.stringify({ ok: true, ...result }) : humanOutput(cmd, result)).replace(
        /\n?$/,
        '\n'
      )
    )
    return exitFor(result)
  } catch (err) {
    return emitFailure(err, wantJson)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(APP_HELP)
    return
  }
  if (APP_COMMANDS.has(argv[0])) {
    process.exitCode = await runApp(argv)
    return
  }
  if (argv[0] !== 'browser') {
    fail(`Unknown command: ${argv[0]}\nRun \`hang4r --help\`.`)
  }
  const rest = argv.slice(1)
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    process.stdout.write(HELP)
    return
  }

  const cmd = rest[0]
  const { positionals, flags } = parseArgs(rest.slice(1))
  const { cmd: normalizedCmd, args } = buildCommand(cmd, positionals, flags)

  const sockPath = process.env.HANG4R_CTL_SOCK
  if (!sockPath) {
    fail(
      'HANG4R_CTL_SOCK is not set — run this from inside a hang4r session (agent, terminal, or setup script).'
    )
  }
  const token = resolveToken(sockPath)
  if (!token) {
    fail('No auth token: set HANG4R_CTL_TOKEN or ensure ctl.token exists next to the socket.')
  }
  const sessionId = process.env.HANG4R_SESSION_ID
  if (!sessionId) {
    fail('HANG4R_SESSION_ID is not set — run this from inside a hang4r session.')
  }

  const response = await send(sockPath, token, { token, sessionId, cmd: normalizedCmd, args })
  if (!response || response.ok !== true) {
    fail(response && response.error ? response.error : 'Command failed.')
  }
  const out = formatResult(normalizedCmd, response.result)
  if (out) process.stdout.write(out.replace(/\n?$/, '\n'))
}

if (require.main === module) {
  main().catch((e) => fail(e && e.message ? e.message : String(e)))
}

module.exports = { pollUntil, discover, parseAppArgs, exitFor, EXIT }
