/**
 * SessionManager.prompt claims a session atomically and rejects when a turn is
 * already in flight. The rejection crosses IPC / the bridge / the control socket
 * as a plain Error message, so callers recognise it by this marker rather than
 * by class.
 */
export const SESSION_BUSY_MARKER = 'hang4r:session-busy'

export const SESSION_BUSY_MESSAGE = `Session is busy: a turn is already running (${SESSION_BUSY_MARKER}).`

export function isSessionBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes(SESSION_BUSY_MARKER)
}

/** a headless prompt hit a session whose worktree is gone and may not ask about it */
export const WORKTREE_MISSING_MARKER = 'hang4r:worktree-missing'

export const WORKTREE_MISSING_MESSAGE = `This session's worktree is gone (${WORKTREE_MISSING_MARKER}). Re-run with --rebuild-worktree to recreate it.`

export function isWorktreeMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes(WORKTREE_MISSING_MARKER)
}

/** a prompt's claim was revoked (Stop / archive / delete / hand-off) before it started */
export const CLAIM_REVOKED_MARKER = 'hang4r:claim-revoked'

export const CLAIM_REVOKED_MESSAGE = `The turn was cancelled before it started (the session was stopped) (${CLAIM_REVOKED_MARKER}).`

export function isClaimRevokedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes(CLAIM_REVOKED_MARKER)
}
