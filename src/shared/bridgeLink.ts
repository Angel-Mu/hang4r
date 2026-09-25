/**
 * Link health for both ends of the mobile bridge: when a socket that still
 * reports OPEN should be presumed dead, when repeated failures mean the
 * pairing changed, and the connection record behind each side's
 * diagnostics panel.
 */

/** awake peers hear something at least every 25s; this much silence is a corpse */
export const LINK_SILENCE_MS = 60_000
export const LINK_CONNECT_TIMEOUT_MS = 15_000
/** consecutive sockets refused before open — enough to rule out a network blip */
export const PAIRING_REJECT_STREAK = 3
export const DIAG_LOG_MAX = 200

export interface LinkLogEntry {
  at: number
  msg: string
}

export interface LinkDiagnostics {
  side: 'desktop' | 'phone'
  state: string
  stateSince: number | null
  lastSentAt: number | null
  lastRxAt: number | null
  lastClose: { code: number; reason: string; at: number } | null
  reconnects: number
  peerVersion: string | null
  log: LinkLogEntry[]
}

export function emptyDiagnostics(side: LinkDiagnostics['side']): LinkDiagnostics {
  return {
    side,
    state: 'idle',
    stateSince: null,
    lastSentAt: null,
    lastRxAt: null,
    lastClose: null,
    reconnects: 0,
    peerVersion: null,
    log: []
  }
}

export function pushLog(log: LinkLogEntry[], msg: string, at = Date.now()): LinkLogEntry[] {
  log.push({ at, msg })
  if (log.length > DIAG_LOG_MAX) log.splice(0, log.length - DIAG_LOG_MAX)
  return log
}

/** An open socket that has heard nothing — not even a pong — for `silenceMs`. */
export function linkIsSilent(
  lastRxAt: number | null,
  now: number,
  silenceMs = LINK_SILENCE_MS
): boolean {
  return lastRxAt !== null && now - lastRxAt >= silenceMs
}

export interface RejectEvidence {
  /** consecutive sockets that closed without ever opening */
  refusedStreak: number
  /** frames from the desktop that didn't decrypt since the last one that did */
  undecryptable: number
  /** whether a plain request to the relay got through meanwhile */
  relayReachable: boolean
}

/**
 * Browsers hide a WebSocket upgrade's HTTP status, so the relay's 403 for a
 * stale token looks exactly like a network failure. Refused sockets while the
 * relay itself answers — or desktop frames under a key we don't hold — are
 * what a re-pair on the computer looks like from here.
 */
export function pairingLooksChanged(e: RejectEvidence): boolean {
  if (e.undecryptable >= PAIRING_REJECT_STREAK) return true
  return e.relayReachable && e.refusedStreak >= PAIRING_REJECT_STREAK
}

function ago(at: number | null, now: number): string {
  if (at === null) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  return `${s}s ago (${new Date(at).toISOString()})`
}

export function diagnosticsText(d: LinkDiagnostics, now = Date.now()): string {
  const lines = [
    `hang4r bridge — ${d.side}`,
    `state: ${d.state}${d.stateSince ? ` since ${ago(d.stateSince, now)}` : ''}`,
    `last frame sent: ${ago(d.lastSentAt, now)}`,
    `last frame received: ${ago(d.lastRxAt, now)}`,
    `last close: ${
      d.lastClose
        ? `${d.lastClose.code ? `${d.lastClose.code} ` : ''}${d.lastClose.reason || '(no reason)'} — ${ago(d.lastClose.at, now)}`
        : 'none'
    }`,
    `reconnects: ${d.reconnects}`,
    `peer version: ${d.peerVersion ?? 'unknown'}`,
    '',
    ...d.log.map((e) => `${new Date(e.at).toISOString()} ${e.msg}`)
  ]
  return lines.join('\n')
}
