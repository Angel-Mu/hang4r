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
      if (!['text', 'url', 'title'].includes(what))
        fail('get needs one of: text | url | title')
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
        .map(
          (t) =>
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
      return entries
        .map((e) => `[${e.level}] ${e.message}`)
        .join('\n')
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

async function main() {
  const argv = process.argv.slice(2)
  // `hang4r`, `hang4r --help`, `hang4r browser --help`
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP)
    return
  }
  if (argv[0] !== 'browser') {
    fail(`Unknown command: ${argv[0]}\nOnly \`hang4r browser …\` is supported. Run \`hang4r --help\`.`)
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

main().catch((e) => fail(e && e.message ? e.message : String(e)))
