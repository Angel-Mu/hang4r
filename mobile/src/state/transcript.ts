import type { AgentQuestion, QuestionAnswer, SessionEvent } from '@shared/protocol'

export interface ToolCall {
  id: string
  name: string
  input: unknown
  result?: unknown
  isError?: boolean
  done: boolean
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; call: ToolCall }

/** `key` is stable across prepends and reloads (derived from the creating
 *  event); absent on transcripts cached before it existed. */
export type Item = (
  | {
      kind: 'user'
      text: string
      images?: { base64: string; mediaType: string }[]
      /** typed in an outside CLI — no user-text event exists to rewind */
      external?: boolean
    }
  | { kind: 'assistant'; messageId: string; blocks: Block[] }
  | { kind: 'note'; text: string; isError?: boolean }
  | {
      kind: 'permission'
      requestId: string
      tool: string
      summary: string
      detail?: string
      options: string[]
      decision?: string
    }
  | {
      kind: 'question'
      requestId: string
      title?: string
      questions: AgentQuestion[]
      answered?: boolean
      /** what was picked (absent on transcripts cached before it was kept) */
      answers?: QuestionAnswer[]
      /** the turn ended before anyone answered — the request is dead */
      cancelled?: boolean
    }
  | { kind: 'turn-end'; isError: boolean; errorMessage?: string; costUsd?: number }
) & { key?: string }

export interface Transcript {
  items: Item[]
  lastSeq: number
  plan: { step: string; status: 'pending' | 'inProgress' | 'completed' }[]
  /** latest context-window occupancy (from usage / turn-complete events) */
  ctxTokens?: number
  ctxWindow?: number
  /** the model id the CLI resolved at session init (`claude-opus-…`) */
  initModel?: string
  /** `before` for the next older page; null = loaded from the start;
   *  undefined = not paged (cache, or a desktop without paging) */
  cursor?: number | null
  /** results whose tool_use is in an older, not yet loaded page — a page cut
   *  mid-turn (one huge turn) separates them */
  orphans?: Record<string, { content: unknown; isError: boolean }>
  /** bumped per older page loaded, so the view can keep its scroll position */
  olderLoads?: number
}

export function emptyTranscript(): Transcript {
  return { items: [], lastSeq: 0, plan: [] }
}

function lastAssistant(
  t: Transcript,
  messageId: string,
  seq: number
): Extract<Item, { kind: 'assistant' }> {
  const last = t.items[t.items.length - 1]
  if (last?.kind === 'assistant' && last.messageId === messageId) return last
  const fresh: Extract<Item, { kind: 'assistant' }> = {
    kind: 'assistant',
    messageId,
    blocks: [],
    key: seq ? `e${seq}` : `m${messageId}`
  }
  t.items.push(fresh)
  return fresh
}

/**
 * A permission/question still open when its turn ends (or the agent exits) can
 * never be answered — same rule as the desktop's cancelStalePending.
 */
function cancelStalePending(t: Transcript): void {
  t.items.forEach((item, i) => {
    if (item.kind === 'permission' && item.decision === undefined) {
      t.items[i] = { ...item, decision: 'cancelled' }
    }
    if (item.kind === 'question' && !item.answered && !item.cancelled) {
      t.items[i] = { ...item, cancelled: true }
    }
  })
}

/** Unresolved permission/question requests — the "needs you" count. */
export function countPending(t: Transcript): number {
  return t.items.filter(
    (it) =>
      (it.kind === 'permission' && !it.decision) ||
      (it.kind === 'question' && !it.answered && !it.cancelled)
  ).length
}

/**
 * Folds one SessionEvent into the transcript, mutating it. Mirrors the
 * desktop renderer's applyEvent but keeps only what the phone renders;
 * subagent streams (parentToolUseId set) are dropped whole in v1.
 * Returns false when the event was a stale replay (seq-gated) or ignored.
 */
export function applyEvent(t: Transcript, ev: SessionEvent): boolean {
  // seq 0 = transient (block-delta) — those bypass the replay/live dedupe gate
  if (ev.seq !== 0) {
    if (ev.seq <= t.lastSeq) return false
    t.lastSeq = ev.seq
  }
  const e = ev.event
  switch (e.kind) {
    case 'user-text':
      t.items.push({ kind: 'user', text: e.text, images: e.images, key: `e${ev.seq}` })
      return true
    case 'external-turn':
      if (e.role === 'user')
        t.items.push({ kind: 'user', text: e.text, external: true, key: `e${ev.seq}` })
      else
        t.items.push({
          kind: 'assistant',
          messageId: `ext-${ev.seq}`,
          blocks: [{ type: 'text', text: e.text }],
          key: `e${ev.seq}`
        })
      return true
    case 'block-start': {
      if (e.parentToolUseId) return false
      const msg = lastAssistant(t, e.messageId, ev.seq)
      if (!msg.blocks[e.blockIndex]) {
        msg.blocks[e.blockIndex] =
          e.blockType === 'tool_use'
            ? { type: 'tool', call: { id: '', name: e.toolName ?? 'tool', input: null, done: false } }
            : e.blockType === 'thinking'
              ? { type: 'thinking', text: '' }
              : { type: 'text', text: '' }
      }
      return true
    }
    case 'block-delta': {
      if (e.parentToolUseId) return false
      const msg = lastAssistant(t, e.messageId, ev.seq)
      const block = (msg.blocks[e.blockIndex] ??= { type: 'text', text: '' })
      if (block.type === 'text' || block.type === 'thinking') block.text += e.text
      return true
    }
    case 'block-final': {
      if (e.parentToolUseId) return false
      const msg = lastAssistant(t, e.messageId, ev.seq)
      const b = e.block
      msg.blocks[e.blockIndex] =
        b.type === 'tool_use'
          ? { type: 'tool', call: { id: b.id, name: b.name, input: b.input, done: false } }
          : b.type === 'thinking'
            ? { type: 'thinking', text: b.thinking }
            : { type: 'text', text: b.text }
      return true
    }
    case 'tool-result': {
      if (e.parentToolUseId) return false
      for (let i = t.items.length - 1; i >= 0; i--) {
        const item = t.items[i]
        if (item.kind !== 'assistant') continue
        for (const block of item.blocks) {
          if (block?.type === 'tool' && block.call.id === e.toolUseId) {
            block.call.result = e.content
            block.call.isError = e.isError
            block.call.done = true
            return true
          }
        }
      }
      ;(t.orphans ??= {})[e.toolUseId] = { content: e.content, isError: e.isError }
      return false
    }
    case 'permission-request':
      t.items.push({
        kind: 'permission',
        requestId: e.requestId,
        tool: e.tool,
        summary: e.summary,
        detail: e.detail,
        options: e.options,
        key: `e${ev.seq}`
      })
      return true
    case 'permission-resolved':
      for (let i = t.items.length - 1; i >= 0; i--) {
        const item = t.items[i]
        if (item.kind === 'permission' && item.requestId === e.requestId) {
          item.decision = e.decision
          return true
        }
      }
      return false
    case 'question-request':
      t.items.push({
        kind: 'question',
        requestId: e.requestId,
        title: e.title,
        questions: e.questions,
        key: `e${ev.seq}`
      })
      return true
    case 'question-resolved':
      for (let i = t.items.length - 1; i >= 0; i--) {
        const item = t.items[i]
        if (item.kind === 'question' && item.requestId === e.requestId) {
          item.answered = true
          item.answers = e.answers
          return true
        }
      }
      return false
    case 'turn-complete':
      cancelStalePending(t)
      if (e.contextTokens) t.ctxTokens = e.contextTokens
      if (e.contextWindowTokens) t.ctxWindow = e.contextWindowTokens
      t.items.push({
        kind: 'turn-end',
        isError: e.isError,
        errorMessage: e.errorMessage,
        costUsd: e.costUsd,
        key: `e${ev.seq}`
      })
      return true
    case 'setup-note':
      t.items.push({ kind: 'note', text: e.text, isError: e.isError, key: `e${ev.seq}` })
      return true
    case 'plan':
      t.plan = e.entries
      return true
    case 'init':
      t.initModel = e.model
      return false
    case 'exit':
      cancelStalePending(t)
      return true
    case 'usage':
      if (e.contextTokens) t.ctxTokens = e.contextTokens
      if (e.contextWindowTokens) t.ctxWindow = e.contextWindowTokens
      return true
    default:
      return false
  }
}

/**
 * An older page folded in front of what is loaded. Its plan and context
 * numbers are older than the ones on screen, so only its items are kept.
 */
export function prependPage(t: Transcript, events: SessionEvent[], cursor: number | null): Transcript {
  const older = emptyTranscript()
  for (const ev of events) applyEvent(older, ev)
  const orphans = { ...t.orphans }
  for (const item of older.items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      const r = block?.type === 'tool' ? orphans[block.call.id] : undefined
      if (block?.type !== 'tool' || !r) continue
      block.call.result = r.content
      block.call.isError = r.isError
      block.call.done = true
      delete orphans[block.call.id]
    }
  }
  Object.assign(orphans, older.orphans)
  return {
    ...t,
    items: [...older.items, ...t.items],
    cursor,
    orphans,
    initModel: t.initModel ?? older.initModel
  }
}

/** The desktop's resume marker is a user-text but not a message you wrote. */
export function canEditUser(item: Extract<Item, { kind: 'user' }>): boolean {
  return !item.external && !/^— resumed: \d+ earlier message/.test(item.text)
}

/** Desktop ChatView's key: identical user messages AFTER each one, so the
 *  desktop can find the same message among repeats. */
export function userOccurrences(items: Item[]): Map<Item, number> {
  const map = new Map<Item, number>()
  const seenAfter = new Map<string, number>()
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind !== 'user' || it.external) continue
    const key = it.text.trim()
    map.set(it, seenAfter.get(key) ?? 0)
    seenAfter.set(key, (seenAfter.get(key) ?? 0) + 1)
  }
  return map
}
