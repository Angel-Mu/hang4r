'use strict'
/*
 * hang4r mcp — a stdio MCP server over the same control-socket calls the CLI
 * makes. Plain Node.js, ZERO npm dependencies (the shipped app has no
 * resolvable @modelcontextprotocol/sdk, and this runs as ELECTRON_RUN_AS_NODE),
 * so the small JSON-RPC 2.0 subset is hand-rolled: initialize,
 * notifications/initialized, ping, tools/list, tools/call. Newline-delimited
 * JSON on stdin/stdout; stdout carries protocol frames ONLY, logs go to stderr.
 *
 * Every tool call opens the socket fresh, so an app restart never breaks a
 * long-lived MCP process.
 */

const cli = require('./hang4r-cli.js')
const { CliError, CODE_TO_EXIT, EXIT } = cli

const SERVER_VERSION = '1.0.0'
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_CAP_S = 50

const MCP_HELP = `hang4r mcp — stdio MCP server for driving hang4r from another agent.

USAGE
  hang4r mcp [--as <name>] [--launch]

  --as <name>   Who is calling; shown in hang4r as "via <name>" (default: the MCP client's
                own name from initialize, e.g. claude-code; "mcp" if it sends none)
  --launch      Start hang4r if it is not running (or HANG4R_AUTO_LAUNCH=1)

ENV
  HANG4R_MCP_WAIT_CAP_S   Longest a single tool call blocks (default ${DEFAULT_CAP_S}). MCP clients
                          commonly time out calls near 60s. On the cap a wait returns
                          reason "timeout" and the agent calls hang4r_wait again.
  HANG4R_USER_DATA        App data dir, as for the CLI.

REGISTER
  claude mcp add hang4r -- hang4r mcp
  ~/.hermes/config.yaml:  mcp_servers: { hang4r: { command: hang4r, args: [mcp, --as, hermes] } }
`

function waitCapS(env) {
  const raw = (env || process.env).HANG4R_MCP_WAIT_CAP_S
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CAP_S
}

/* ---------------- tools ---------------- */

const SESSION_ID = {
  type: 'string',
  description: 'Session id, as returned by hang4r_new_session or hang4r_list_sessions.'
}
const WAIT_FLAG = {
  type: 'boolean',
  description:
    'Block (up to the server wait cap) until the turn ends, then return its outcome. ' +
    'On reason "timeout" the turn is still running: call hang4r_wait with resumeAfter as `after`.'
}

const TOOLS = [
  {
    name: 'hang4r_status',
    description:
      'Check that the hang4r desktop app is running and reachable. Returns its version and data directory. ' +
      'Call this first if any other hang4r tool reports "unreachable".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    cmd: 'app.status',
    build: () => ({})
  },
  {
    name: 'hang4r_list_projects',
    description:
      'List the projects already added in hang4r (id, name, path, session count). ' +
      'The `project` argument of hang4r_new_session takes an id, an exact name, or an absolute path from this list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    cmd: 'app.projects',
    build: () => ({})
  },
  {
    name: 'hang4r_list_models',
    description:
      'List the model ids each backend (claude, codex, cursor) offers: backend, id, label, and which one is hang4r\'s ' +
      'default. The `model` argument of hang4r_new_session takes an id from this list. Omit `backend` for all of them.',
    inputSchema: {
      type: 'object',
      properties: {
        backend: { type: 'string', enum: ['claude', 'codex', 'cursor'], description: 'Only this backend\'s models.' }
      },
      additionalProperties: false
    },
    cmd: 'app.models',
    build: (a) => ({ backend: a.backend })
  },
  {
    name: 'hang4r_list_sessions',
    description:
      'List hang4r agent sessions, newest first: id, status (idle, running, starting, error, archived), ' +
      'backend, title, project. Use the id with hang4r_show_session, hang4r_send, hang4r_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, description: 'Maximum sessions to return (default 50).' }
      },
      additionalProperties: false
    },
    cmd: 'app.sessions',
    build: (a) => ({ limit: a.limit })
  },
  {
    name: 'hang4r_new_session',
    description:
      'Start a new agent session (Claude Code, Codex or Cursor) in a hang4r project. With a `prompt` the first turn starts ' +
      'immediately; without one you get an idle session to hang4r_send to later. Returns the session and `after`, the ' +
      'transcript position to pass to hang4r_wait. With wait:true it blocks up to the server wait cap and returns the ' +
      'outcome (reason turn-complete with the agent\'s result, needs-input, or timeout; on timeout call hang4r_wait).',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'Project id, exact name or absolute path of a project already in hang4r (see hang4r_list_projects). ' +
            'Omitted: the project containing this server\'s working directory.'
        },
        backend: { type: 'string', enum: ['claude', 'codex', 'cursor'], description: 'Agent CLI to run (default claude).' },
        model: { type: 'string', description: 'Model id for the backend. Omitted: hang4r\'s default.' },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Reasoning effort, where the backend supports it.'
        },
        env: {
          type: 'string',
          enum: ['local', 'worktree'],
          description:
            'local = work in the project directory; worktree = an isolated git worktree. ' +
            'Omitted: the same default as the app\'s Start-agent dialog.'
        },
        permission_mode: {
          type: 'string',
          enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
          description:
            'How the agent asks before acting. Any mode is allowed. With "default" the agent may block on a permission; ' +
            'wait then returns needs-input and you answer with hang4r_respond.'
        },
        title: { type: 'string', description: 'Session title shown in hang4r.' },
        prompt: { type: 'string', description: 'First message. Omitted: create an idle session.' },
        wait: WAIT_FLAG
      },
      additionalProperties: false
    },
    cmd: 'app.new',
    build: (a, ctx) => ({
      prompt: a.prompt,
      project: a.project,
      cwd: process.cwd(),
      backend: a.backend,
      model: a.model,
      effort: a.effort,
      env: a.env,
      permissionMode: a.permission_mode,
      title: a.title,
      wait: !!a.wait && !!a.prompt,
      timeout: ctx.cap
    }),
  },
  {
    name: 'hang4r_show_session',
    description:
      'Inspect one session: status, backend, the pending permission/question request if the agent is blocked ' +
      '(session.pending with requestId and options), the last result, and the most recent transcript events.',
    inputSchema: {
      type: 'object',
      properties: { session_id: SESSION_ID },
      required: ['session_id'],
      additionalProperties: false
    },
    cmd: 'app.show',
    build: (a) => ({ sessionId: a.session_id })
  },
  {
    name: 'hang4r_send',
    description:
      'Send a follow-up prompt to an idle session, starting a new turn. If the session is already running a turn this ' +
      'returns reason "busy" (a normal result, not an error): hang4r_wait for the running turn first, or ' +
      'hang4r_interrupt it. Returns `after`, the transcript position for hang4r_wait. With wait:true it blocks up to ' +
      'the server wait cap and returns the outcome; on timeout call hang4r_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        prompt: { type: 'string', description: 'The message to send.' },
        wait: WAIT_FLAG,
        rebuild_worktree: {
          type: 'boolean',
          description: 'Recreate the session\'s git worktree if it was removed (otherwise that fails with worktree-missing).'
        }
      },
      required: ['session_id', 'prompt'],
      additionalProperties: false
    },
    cmd: 'app.send',
    build: (a, ctx) => ({
      sessionId: a.session_id,
      prompt: a.prompt,
      wait: !!a.wait,
      rebuildWorktree: !!a.rebuild_worktree,
      timeout: ctx.cap
    }),
  },
  {
    name: 'hang4r_wait',
    description:
      'Block (up to the server wait cap) until a session\'s turn ends or the agent needs you. The `reason` says which: ' +
      '"turn-complete" (read `result`), "needs-input" (the agent is blocked on a permission or question: read ' +
      'session.pending, then call hang4r_respond with its requestId, then wait again), "timeout" (still running: call ' +
      'hang4r_wait again with after = resumeAfter), "idle" (nothing running), or an error. Pass `after` from ' +
      'hang4r_new_session / hang4r_send so only the turn you started counts; a turn that finished earlier never satisfies it.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        after: {
          type: 'integer',
          minimum: 0,
          description: 'Transcript position from hang4r_new_session, hang4r_send, hang4r_respond or a previous timeout\'s resumeAfter.'
        },
        timeout_s: {
          type: 'number',
          minimum: 0,
          description: 'Seconds to block, clamped to the server wait cap. 0 = check once. Default: the cap.'
        }
      },
      required: ['session_id'],
      additionalProperties: false
    },
    cmd: 'app.wait',
    build: (a, ctx) => ({
      sessionId: a.session_id,
      after: a.after,
      timeout: a.timeout_s === undefined ? ctx.cap : Math.min(a.timeout_s, ctx.cap)
    }),
  },
  {
    name: 'hang4r_interrupt',
    description:
      'Stop the turn a session is running. The session returns to idle and can be sent a new prompt. ' +
      'Harmless on an idle session.',
    inputSchema: {
      type: 'object',
      properties: { session_id: SESSION_ID },
      required: ['session_id'],
      additionalProperties: false
    },
    cmd: 'app.interrupt',
    build: (a) => ({ sessionId: a.session_id })
  },
  {
    name: 'hang4r_respond',
    description:
      'Answer the permission request or question a session is blocked on (hang4r_wait returned needs-input; the ' +
      'request is in session.pending). Permission: decision "allow" or "deny". Question: options = the chosen option ids. ' +
      'Fails with not-found if the request is no longer live. Returns `after`; with wait:true it blocks up to the ' +
      'server wait cap for the resumed turn.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        request_id: { type: 'string', description: 'session.pending.requestId.' },
        decision: { type: 'string', enum: ['allow', 'deny'], description: 'For a permission request.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'For a question: the chosen option ids (session.pending.questions[].options[].id).'
        },
        wait: WAIT_FLAG
      },
      required: ['session_id', 'request_id'],
      additionalProperties: false
    },
    cmd: 'app.respond',
    build: (a, ctx) => ({
      sessionId: a.session_id,
      requestId: a.request_id,
      decision: a.decision,
      options: a.options,
      wait: !!a.wait,
      timeout: ctx.cap
    }),
  }
]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** Light validation against the declared schema; the app re-validates semantics. */
function validate(tool, args) {
  const schema = tool.inputSchema
  const props = schema.properties
  for (const r of schema.required || []) {
    if (args[r] === undefined || args[r] === null || args[r] === '')
      throw new CliError('usage', `Missing required argument: ${r}`)
  }
  for (const [k, v] of Object.entries(args)) {
    const p = props[k]
    if (!p) throw new CliError('usage', `Unknown argument: ${k}`)
    if (v === undefined || v === null) continue
    const ok =
      p.type === 'string'
        ? typeof v === 'string'
        : p.type === 'boolean'
          ? typeof v === 'boolean'
          : p.type === 'integer'
            ? Number.isInteger(v)
            : p.type === 'number'
              ? typeof v === 'number' && Number.isFinite(v)
              : p.type === 'array'
                ? Array.isArray(v) && v.every((x) => typeof x === 'string')
                : true
    if (!ok) throw new CliError('usage', `Argument ${k} must be a ${p.type}`)
    if (p.enum && !p.enum.includes(v)) throw new CliError('usage', `Argument ${k} must be one of: ${p.enum.join(', ')}`)
    if (typeof p.minimum === 'number' && typeof v === 'number' && v < p.minimum)
      throw new CliError('usage', `Argument ${k} must be >= ${p.minimum}`)
  }
}

/* ---------------- calling the app ---------------- */

async function call(ctx, cmd, args) {
  const { sockPath, envToken } = cli.discover()
  await cli.ensureRunning(sockPath, ctx.launch || process.env.HANG4R_AUTO_LAUNCH === '1')
  const token = cli.readToken(sockPath, envToken)
  if (!token) throw new CliError('auth', 'No auth token: ctl.token is missing next to the socket.')
  const res = await cli.appRequest(sockPath, token, { cmd, args, caller: ctx.caller })
  if (!res || res.ok !== true) {
    throw new CliError(res && res.code ? res.code : 'internal', res && res.error ? res.error : 'Command failed.')
  }
  return res.result || {}
}

/** One tool call -> { structured, isError }. Throws CliError for failures. */
async function runTool(tool, args, ctx) {
  const built = tool.build(args, ctx)
  let result
  if (built.wait) {
    // Two socket calls instead of one waiting call: the acting call hands back
    // `after`, which a timed-out wait needs to be resumable.
    const rest = { ...built, wait: false }
    delete rest.timeout
    const acted = await call(ctx, tool.cmd, rest)
    try {
      result = await call(ctx, 'app.wait', {
        sessionId: acted.session.id,
        after: acted.after,
        timeout: built.timeout
      })
    } catch (err) {
      // The act succeeded and the turn is running (or done): losing its session id and
      // `after` here would push the agent to re-send or create a duplicate session.
      const f = failure(err)
      return {
        structured: {
          ...f.structured,
          sent: true,
          session: acted.session,
          after: acted.after,
          hint:
            'The prompt WAS delivered and the turn started; only the wait failed. Do NOT send again or create another ' +
            'session. Call hang4r_wait with this session_id and `after` once hang4r is reachable (hang4r_status checks).'
        },
        isError: true
      }
    }
  } else {
    result = await call(ctx, tool.cmd, built)
  }
  return shape(tool, result)
}

/** Map a successful app result onto the MCP result: busy/needs-input/timeout are normal, failures are errors. */
function shape(tool, result) {
  if (typeof result.reason !== 'string') return { structured: result, isError: false }
  const out = { ...result }
  if (result.reason === 'timeout') {
    out.resumeAfter = result.after
    delete out.after
    out.hint = 'Still running. Call hang4r_wait with this session_id and after = resumeAfter.'
    return { structured: out, isError: false }
  }
  if (result.reason === 'needs-input') {
    out.hint = 'The agent is blocked on session.pending. Answer it with hang4r_respond, then hang4r_wait again.'
    return { structured: out, isError: false }
  }
  if (result.reason === 'archived') {
    return {
      structured: { code: 'not-found', exitCode: EXIT.notFound, message: 'That session is archived.', ...out },
      isError: true
    }
  }
  if (result.reason === 'error' || (result.reason === 'turn-complete' && result.isError)) {
    return {
      structured: {
        ...out,
        code: 'turn-error',
        exitCode: EXIT.turnError,
        message: result.errorMessage || 'The turn ended in an error.'
      },
      isError: true
    }
  }
  return { structured: out, isError: false }
}

function failure(err) {
  const code = err && err.code && CODE_TO_EXIT[err.code] !== undefined ? err.code : 'internal'
  return {
    structured: { code, message: (err && err.message) || String(err), exitCode: CODE_TO_EXIT[code] },
    isError: true
  }
}

async function callTool(name, rawArgs, ctx) {
  const tool = BY_NAME.get(name)
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}
  try {
    validate(tool, args)
    return await runTool(tool, args, ctx)
  } catch (err) {
    if (err instanceof CliError && err.code === 'busy') {
      // busy is an answer, not a failure: say so and show what is running
      let session
      try {
        if (args.session_id) session = (await call(ctx, 'app.show', { sessionId: args.session_id })).session
      } catch {
        /* best effort */
      }
      return {
        structured: {
          reason: 'busy',
          message: 'The session is running a turn. hang4r_wait for it, or hang4r_interrupt it, then send again.',
          session
        },
        isError: false
      }
    }
    return failure(err)
  }
}

/* ---------------- JSON-RPC ---------------- */

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }
}

async function handleMessage(msg, ctx, state) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'Invalid Request')
  }
  const isNotification = msg.id === undefined
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion
      state.client = (msg.params && msg.params.clientInfo) || null
      // origin defaults to the client's own name ("via claude-code"); --as wins
      if (!ctx.explicitAs) {
        const named = cleanCaller(state.client && state.client.name)
        if (named) ctx.caller = named
      }
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'hang4r', version: SERVER_VERSION }
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      })
    case 'tools/call': {
      const name = msg.params && msg.params.name
      if (!BY_NAME.has(name)) return isNotification ? null : rpcError(msg.id, -32602, `Unknown tool: ${name}`)
      const { structured, isError } = await callTool(name, msg.params.arguments, ctx)
      return reply({
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
        isError
      })
    }
    default:
      // notifications (initialized, cancelled, …) need no answer
      return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
  }
}

/** Same scrub the app applies to a caller label (appControlService.cleanCaller). */
function cleanCaller(v) {
  if (typeof v !== 'string') return undefined
  return v.replace(/[^\w.@:-]/g, '').slice(0, 40) || undefined
}

function parseMcpArgs(argv) {
  const flags = { as: undefined, launch: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') flags.help = true
    else if (a === '--launch') flags.launch = true
    else if (a === '--as') {
      if (argv[i + 1] === undefined) throw new CliError('usage', '--as needs a value')
      flags.as = argv[++i]
    } else if (a.startsWith('--as=')) flags.as = a.slice(5)
    else throw new CliError('usage', `Unknown argument ${a}. Run \`hang4r mcp --help\`.`)
  }
  return flags
}

/** Serve MCP on stdio until stdin closes. Resolves with the process exit code. */
function runMcp(argv) {
  let flags
  try {
    flags = parseMcpArgs(argv)
  } catch (err) {
    process.stderr.write(`hang4r mcp: ${err.message}\n`)
    return Promise.resolve(EXIT.usage)
  }
  if (flags.help) {
    process.stdout.write(MCP_HELP)
    return Promise.resolve(EXIT.ok)
  }
  const ctx = { caller: flags.as || 'mcp', explicitAs: !!flags.as, launch: flags.launch, cap: waitCapS() }
  const state = { client: null }
  process.stderr.write(`hang4r mcp: serving on stdio as "${ctx.caller}" (wait cap ${ctx.cap}s)\n`)
  return new Promise((resolve) => {
    let buf = ''
    let inflight = 0
    let ended = false
    const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
    const maybeDone = () => {
      if (ended && inflight === 0) resolve(EXIT.ok)
    }
    const onLine = async (line) => {
      if (!line.trim()) return
      inflight++
      try {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          write(rpcError(null, -32700, 'Parse error'))
          return
        }
        const out = await handleMessage(msg, ctx, state)
        if (out) write(out)
      } catch (err) {
        process.stderr.write(`hang4r mcp: ${err && err.stack ? err.stack : err}\n`)
      } finally {
        inflight--
        maybeDone()
      }
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        void onLine(line)
      }
    })
    process.stdin.on('end', () => {
      if (buf.trim()) void onLine(buf)
      buf = ''
      ended = true
      maybeDone()
    })
  })
}

module.exports = { runMcp, handleMessage, TOOLS, waitCapS, parseMcpArgs }
