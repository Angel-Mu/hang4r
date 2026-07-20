import type { BackendId } from '../../shared/protocol'

/**
 * How "edit an already-sent message" behaves per backend — the single honest
 * decision point so the UI copy and the sessionManager routing can never drift.
 *
 *  - `fork`     — Claude Code: a TRUE fork. Walk the CLI's jsonl parent-UUID DAG
 *                 and re-spawn with `--resume-session-at`, truncating everything
 *                 after the edited message.
 *  - `rollback` — Codex: a TRUE in-place truncation via the app-server
 *                 `thread/rollback` RPC (verified live: turn N+1 no longer sees a
 *                 rolled-back turn). Same thread id, so the next turn continues
 *                 from the truncated point. Falls back to `append` at runtime if
 *                 the backend refuses (the method is already deprecated upstream).
 *  - `append`   — Cursor: NO fork/truncate primitive exists (`--resume` only
 *                 appends), so the edited text is honestly resent as a NEW turn.
 *                 The earlier messages stay; nothing is pretended-away.
 */
export type RewindStrategy = 'fork' | 'rollback' | 'append'

export function rewindStrategyFor(backend: BackendId): RewindStrategy {
  switch (backend) {
    case 'claude':
      return 'fork'
    case 'codex':
      return 'rollback'
    case 'cursor':
      return 'append'
    default:
      return 'append'
  }
}

/**
 * Whether a strategy discards the intervening history (a true rewind) versus
 * appending a new turn. Drives whether hang4r truncates its own transcript.
 */
export function rewindDiscardsHistory(strategy: RewindStrategy): boolean {
  return strategy !== 'append'
}

/**
 * Codex rollback depth: how many trailing turns to drop = every user turn from
 * the edited message (inclusive) to the end of the conversation. Each Codex
 * `turn/start` is one user message, so hang4r's user-text events map 1:1 to
 * backend turns. `userSeqs` are the store sequences of the transcript's
 * user-text events in order; `targetSeq` is the edited message's sequence.
 */
export function turnsToRewind(userSeqs: number[], targetSeq: number): number {
  return userSeqs.filter((seq) => seq >= targetSeq).length
}
