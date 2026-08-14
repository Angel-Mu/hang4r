/**
 * Mobile bridge protocol — shared by the desktop bridge service, the relay
 * smoke tooling, and the mobile app. Frames travel desktop ↔ phone through
 * the relay as AES-256-GCM ciphertext; the relay only ever routes bytes.
 * See docs/mobile/design.md.
 */

import type { SessionEvent, SessionMeta } from './protocol'

export const DEFAULT_RELAY_URL = 'wss://hang4r-relay.angel-malavar.workers.dev'

/** Contents of the pairing QR / paste-code. */
export interface BridgePairing {
  v: 1
  deviceId: string
  /** base64url pairSecret — the root both the E2E key and relay token derive from */
  secret: string
  relay: string
}

export function encodePairingUrl(p: BridgePairing): string {
  const q = new URLSearchParams({ v: '1', device: p.deviceId, secret: p.secret, relay: p.relay })
  return `hang4r://pair?${q}`
}

export function parsePairingUrl(url: string): BridgePairing | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'hang4r:' || u.hostname !== 'pair') return null
    const deviceId = u.searchParams.get('device')
    const secret = u.searchParams.get('secret')
    const relay = u.searchParams.get('relay')
    if (u.searchParams.get('v') !== '1' || !deviceId || !secret || !relay) return null
    return { v: 1, deviceId, secret, relay }
  } catch {
    return null
  }
}

/** HKDF `info` labels — distinct so the relay-visible token can never be the E2E key. */
export const HKDF_SALT = 'hang4r-bridge'
export const HKDF_INFO_E2E = 'h4/e2e'
export const HKDF_INFO_RELAY = 'h4/relay'

/** phone → desktop */
export type BridgeClientFrame =
  | { t: 'hello'; role: 'client'; appVersion: string }
  | { t: 'req'; id: number; method: string; params: unknown[] }
  | { t: 'sub'; sessionId: string }
  | { t: 'unsub'; sessionId: string }
  | { t: 'ping' }

/** desktop → phone */
export type BridgeDesktopFrame =
  | { t: 'hello'; role: 'desktop'; appVersion: string }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'event'; channel: 'agent-event'; payload: SessionEvent }
  | { t: 'event'; channel: 'session-updated'; payload: SessionMeta }
  | { t: 'ping' }

/**
 * Plaintext (text) frames — the deliberately relay-VISIBLE channel. Only
 * content-free signals live here; everything else rides the E2E binary frames.
 * - peer: relay → both sides, presence.
 * - notify: desktop → relay when no phone is connected; the relay turns it
 *   into an APNs push (generic text only — never session content).
 * - apns: phone → relay, registers its push token with the device's DO.
 */
export type RelayControlFrame =
  | { t: 'peer'; connected: boolean }
  | {
      t: 'notify'
      kind: 'turn-complete' | 'needs-approval' | 'turn-error'
      /** opaque UUID so a push tap can deep-open the session */
      sessionId?: string
      /** session title for the push text — a DELIBERATE privacy tradeoff
       *  (Angel's call): the relay can read this frame, so the title
       *  transits unencrypted. Truncated; never message content. */
      title?: string
    }
  | { t: 'apns'; token: string }

/**
 * The Hang4rApi subset a phone may call. Deliberately excludes anything that
 * writes files, runs terminals, or edits settings — the phone drives
 * conversations, it does not get the desktop's full authority.
 */
export const BRIDGE_METHODS = [
  'listProjects',
  'listSessions',
  'listArchivedSessions',
  'getSessionEvents',
  'prompt',
  'interrupt',
  'createSession',
  'respondPermission',
  'respondQuestion',
  'renameSession',
  'archiveSession',
  'unarchiveSession',
  'retrySession',
  'authStatus',
  'listCodexModels',
  'listCursorModels',
  'resolveAgentDefault',
  'scopeSummary',
  'scopedFiles',
  'scopedDiff',
  'submitReview',
  'markSeen',
  'claudeUsage',
  'codexUsage',
  'cursorUsage',
  'appVersion',
  'agentAlive',
  'currentBranch',
  'resyncSession'
] as const

export type BridgeMethod = (typeof BRIDGE_METHODS)[number]

export interface BridgeStatus {
  enabled: boolean
  relayConnected: boolean
  phoneConnected: boolean
  deviceId: string | null
  relayUrl: string
  /** desktop holds a system-sleep block while the bridge is on */
  keepAwake: boolean
}
