import type { BridgeEventPage } from '../../shared/bridge'
import type { AgentEvent, SessionEvent } from '../../shared/protocol'

/** What the phone's tool chip shows of a result (SessionScreen ToolChip). */
export const PHONE_RESULT_CHARS = 2000
/** What the phone's approval card shows of a permission detail. */
export const PHONE_DETAIL_CHARS = 1200
/** Default page budget, in JSON bytes of slimmed events. */
export const PAGE_BUDGET_BYTES = 256 * 1024
/** A page never exceeds this — a single turn bigger than it is cut mid-turn.
 *  The relay drops (1009) frames past its message cap, then the desktop
 *  reconnects and the phone reloads: the loop the whole paging exists to end. */
export const PAGE_HARD_MAX_BYTES = 768 * 1024

/** Kinds the phone's transcript reducer drops (mobile/src/state/transcript.ts). */
const PHONE_IGNORED = new Set<AgentEvent['kind']>([
  'subagent-note',
  'hook',
  'rate-limit',
  'stderr'
])

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

/** The event as the phone needs it, or null when the phone ignores it —
 *  for live frames and history alike. */
export function slimEventForPhone(e: AgentEvent): AgentEvent | null {
  if (PHONE_IGNORED.has(e.kind)) return null
  if ('parentToolUseId' in e && e.parentToolUseId) return null
  switch (e.kind) {
    case 'tool-result': {
      // the phone shows the first 2000 chars of exactly this rendering
      const shown =
        typeof e.content === 'string' ? e.content : JSON.stringify(e.content, null, 2) ?? ''
      if (shown.length <= PHONE_RESULT_CHARS) return e
      return { ...e, content: cap(shown, PHONE_RESULT_CHARS) }
    }
    case 'permission-request':
      return e.detail && e.detail.length > PHONE_DETAIL_CHARS
        ? { ...e, detail: cap(e.detail, PHONE_DETAIL_CHARS) }
        : e
    case 'user-text': {
      if (!e.files && !e.images?.length) return e
      // one image past the page cap would make an unsendable frame by itself
      const images = e.images?.filter((i) => i.base64.length < PAGE_HARD_MAX_BYTES / 2)
      return { kind: e.kind, text: e.text, ...(images?.length && { images }) }
    }
    case 'turn-complete': {
      const slim = { ...e }
      delete slim.result
      delete slim.errorDetail
      delete slim.permissionDenials
      return slim
    }
    case 'init':
      return { ...e, tools: [], mcpServers: [], skills: [], slashCommands: [], plugins: [] }
    default:
      return e
  }
}

/**
 * Walks events newest-first and yields the ones a phone history needs.
 * Only the newest usage and plan in a run change what the phone shows (both
 * overwrite), so older ones are dropped.
 */
function* slimBackward(rows: Iterable<SessionEvent>): Generator<SessionEvent> {
  let ctxSeen = false
  let planSeen = false
  for (const row of rows) {
    const e = slimEventForPhone(row.event)
    if (!e || e.kind === 'block-delta') continue
    if (e.kind === 'usage') {
      if (ctxSeen) continue
      if (e.contextTokens) ctxSeen = true
    }
    if (e.kind === 'turn-complete' && e.contextTokens) ctxSeen = true
    if (e.kind === 'plan') {
      if (planSeen) continue
      planSeen = true
    }
    yield e === row.event ? row : { ...row, event: e }
  }
}

/** Whole-transcript variant for the legacy getSessionEvents bridge call. */
export function slimHistory(events: SessionEvent[]): SessionEvent[] {
  return [...slimBackward([...events].reverse())].reverse()
}

export interface PageSource {
  /** events with seq < before (all when undefined), newest first */
  backward(before: number | undefined): Iterable<SessionEvent>
  /** the newest event of `kind` with seq < before */
  latest(kind: 'init' | 'plan', before: number): SessionEvent | undefined
}

/**
 * The newest slice of a transcript that fits `budget`, cut on a turn boundary
 * (anywhere else orphans a tool-result from its tool_use) unless one turn
 * alone passes the hard cap. `cursor` is the `before` for the next page.
 */
export function eventPage(
  src: PageSource,
  opts: { before?: number; budget?: number } = {}
): BridgeEventPage {
  const budget = Math.min(Math.max(opts.budget ?? PAGE_BUDGET_BYTES, 1), PAGE_HARD_MAX_BYTES)
  const picked: SessionEvent[] = []
  let bytes = 0
  let cursor: number | null = null
  for (const ev of slimBackward(src.backward(opts.before))) {
    // a turn-complete ends the PREVIOUS (older) turn: stopping before it
    // leaves this page starting on a turn's first event
    if (ev.event.kind === 'turn-complete' && bytes >= budget && picked.length) {
      cursor = ev.seq + 1
      break
    }
    const size = JSON.stringify(ev).length
    if (picked.length && bytes + size > PAGE_HARD_MAX_BYTES) {
      cursor = ev.seq + 1
      break
    }
    picked.push(ev)
    bytes += size
  }
  picked.reverse()
  // the first page must still carry what the phone reads from older events
  if (opts.before === undefined && cursor !== null) {
    const extra: SessionEvent[] = []
    for (const kind of ['init', 'plan'] as const) {
      if (picked.some((e) => e.event.kind === kind)) continue
      const ev = src.latest(kind, cursor)
      const slim = ev && slimEventForPhone(ev.event)
      if (ev && slim) extra.push({ ...ev, event: slim })
    }
    picked.unshift(...extra.sort((a, b) => a.seq - b.seq))
  }
  return { events: picked, cursor }
}
