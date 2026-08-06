import type { AgentEvent, BackendId } from '../../shared/protocol'

/** human label for a backend id */
export function backendLabel(b: BackendId): string {
  return b === 'codex' ? 'Codex' : b === 'cursor' ? 'Cursor' : 'Claude Code'
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** the most telling field of a tool input, for a one-line "ran X: Y" summary */
function summarizeInput(input: unknown): string {
  if (input == null || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick =
    o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.description ?? o.prompt
  if (typeof pick === 'string') return truncate(pick.replace(/\s+/g, ' ').trim(), 120)
  try {
    return truncate(JSON.stringify(o).replace(/\s+/g, ' '), 120)
  } catch {
    return ''
  }
}

/** flatten a tool_result payload (string, or an array of content blocks) to text */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : ''
      )
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export interface HandoffOpts {
  sourceBackend: BackendId
  /** char budget for the reconstructed history (tail-sliced to fit). Cursor gets
   *  less because its prompt is passed as an argv (subject to ARG_MAX). */
  maxChars: number
}

/**
 * Reconstruct a readable transcript from a session's normalized AgentEvent stream
 * and wrap it as a SEED prompt for a DIFFERENT backend to take over (Angel: hit
 * my Claude limit, keep going on Codex). This is a RECONSTRUCTION — the new agent
 * reads a text record (tool calls summarized as prose), not live tool state — not
 * a native resume: backend session ids don't cross agents. Thinking blocks are
 * dropped (internal + large); the history is tail-sliced to `maxChars`.
 */
export function buildHandoffSeed(events: AgentEvent[], opts: HandoffOpts): string {
  const turns: string[] = []
  let assistant: string[] = []
  const flush = (): void => {
    if (assistant.length) {
      turns.push('Assistant:\n' + assistant.join('\n'))
      assistant = []
    }
  }
  for (const ev of events) {
    switch (ev.kind) {
      case 'user-text':
        flush()
        if (ev.text?.trim()) turns.push('User:\n' + ev.text.trim())
        break
      case 'external-turn':
        flush()
        if (ev.text?.trim())
          turns.push((ev.role === 'user' ? 'User:\n' : 'Assistant:\n') + ev.text.trim())
        break
      case 'block-final': {
        const b = ev.block
        if (b.type === 'text' && b.text.trim()) assistant.push(b.text.trim())
        else if (b.type === 'tool_use') {
          const s = summarizeInput(b.input)
          assistant.push(`  · ran ${b.name}${s ? `: ${s}` : ''}`)
        }
        // thinking blocks intentionally skipped
        break
      }
      case 'tool-result': {
        const t = resultText(ev.content).replace(/\s+/g, ' ').trim()
        if (t) assistant.push(`    → ${truncate(t, 200)}`)
        break
      }
      default:
        break
    }
  }
  flush()

  let body = turns.join('\n\n')
  let clipped = false
  if (body.length > opts.maxChars) {
    body = body.slice(body.length - opts.maxChars)
    const brk = body.indexOf('\n\n') // start at a clean turn boundary
    if (brk > 0) body = body.slice(brk + 2)
    clipped = true
  }

  const preamble =
    `You are taking over a coding session that another AI agent (${backendLabel(opts.sourceBackend)}) was handling — the user reached that agent's usage limit and wants to continue with you. You are in the SAME working directory with the SAME files and tools, so you can pick up exactly where it left off.\n\n` +
    (clipped
      ? `Here is the TAIL of the conversation so far (earlier turns were trimmed to fit):\n\n`
      : `Here is the conversation so far:\n\n`)
  const footer =
    `\n\n---\nThat is the history from the previous agent. In one or two sentences, confirm you've reviewed it and say where things stand, then wait for the user's next instruction.`
  return preamble + body + footer
}
