import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'crypto'
import { powerSaveBlocker } from 'electron'
import {
  DEFAULT_RELAY_URL,
  HKDF_INFO_E2E,
  HKDF_INFO_RELAY,
  HKDF_SALT,
  encodePairingUrl,
  type BridgeClientFrame,
  type BridgeDesktopFrame,
  type BridgeStatus
} from '../../shared/bridge'
import type { SessionEvent, SessionMeta } from '../../shared/protocol'

interface SettingsLike {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

interface BridgeIdentity {
  deviceId: string
  pairSecret: string
}

const ID_KEY = 'bridgeIdentityV1'
const ENABLED_KEY = 'bridgeEnabledV1'
const NEEDS_RESET_KEY = 'bridgeNeedsResetV1'
const RELAY_URL_KEY = 'bridgeRelayUrlV1'
const KEEP_AWAKE_KEY = 'bridgeKeepAwakeV1'

const PING_MS = 25_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/**
 * Desktop side of the mobile bridge: one outbound WebSocket to the relay,
 * E2E-encrypted frames, a request router over the BRIDGE_METHODS allowlist,
 * and fan-out of agent-event / session-updated to the paired phone.
 *
 * Instantiated once in registerIpc; the api map is built there because that's
 * where SessionManager, Store, and the usage persistence adapter are in scope.
 */
export class BridgeService {
  private ws: WebSocket | null = null
  private key: Buffer | null = null
  private relayToken = ''
  private subs = new Set<string>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private backoffMs = BACKOFF_MIN_MS
  private disposed = false
  private relayConnected = false
  private phoneConnected = false
  private psbId: number | null = null

  constructor(
    private settings: SettingsLike,
    private api: Record<string, (...args: never[]) => unknown>,
    private appVersion: string,
    private onStatus: (s: BridgeStatus) => void
  ) {
    if (this.enabled) this.connect()
    this.syncKeepAwake()
  }

  get enabled(): boolean {
    return this.settings.getSetting(ENABLED_KEY) === '1'
  }

  get keepAwake(): boolean {
    return this.settings.getSetting(KEEP_AWAKE_KEY) !== '0'
  }

  setKeepAwake(on: boolean): void {
    this.settings.setSetting(KEEP_AWAKE_KEY, on ? '1' : '0')
    this.syncKeepAwake()
    this.emitStatus()
  }

  /** A sleeping Mac is unreachable from the phone — while the bridge is on
   *  (and the user hasn't opted out) hold a system-sleep block. Display sleep
   *  is untouched; this only keeps the machine itself awake. */
  private syncKeepAwake(): void {
    const want = this.enabled && this.keepAwake && !this.disposed
    if (want && this.psbId === null) {
      this.psbId = powerSaveBlocker.start('prevent-app-suspension')
    } else if (!want && this.psbId !== null) {
      powerSaveBlocker.stop(this.psbId)
      this.psbId = null
    }
  }

  relayUrl(): string {
    return (
      process.env.HANG4R_RELAY_URL || this.settings.getSetting(RELAY_URL_KEY) || DEFAULT_RELAY_URL
    )
  }

  status(): BridgeStatus {
    return {
      enabled: this.enabled,
      relayConnected: this.relayConnected,
      phoneConnected: this.phoneConnected,
      deviceId: this.enabled ? this.identity().deviceId : null,
      relayUrl: this.relayUrl(),
      keepAwake: this.keepAwake
    }
  }

  setEnabled(on: boolean): BridgeStatus {
    this.settings.setSetting(ENABLED_KEY, on ? '1' : '0')
    if (on) this.connect()
    else this.disconnect()
    this.syncKeepAwake()
    return this.status()
  }

  pairingUrl(): string {
    const id = this.identity()
    return encodePairingUrl({
      v: 1,
      deviceId: id.deviceId,
      secret: id.pairSecret,
      relay: this.relayUrl()
    })
  }

  /** Rotate the pairing secret: old phones are cut off, the QR must be re-scanned. */
  repair(): string {
    const identity: BridgeIdentity = {
      deviceId: this.identity().deviceId,
      pairSecret: randomBytes(32).toString('base64url')
    }
    this.settings.setSetting(ID_KEY, JSON.stringify(identity))
    this.settings.setSetting(NEEDS_RESET_KEY, '1')
    this.key = null
    this.relayToken = ''
    if (this.enabled) {
      this.disconnect()
      this.connect()
    }
    return this.pairingUrl()
  }

  onAgentEvent(ev: SessionEvent): void {
    const kind = ev.event.kind
    // deltas and mid-turn usage are the firehose — only for the session the
    // phone is actually looking at; everything else drives badges/approvals
    if ((kind === 'block-delta' || kind === 'usage') && !this.subs.has(ev.sessionId)) return
    this.send({ t: 'event', channel: 'agent-event', payload: ev })
    this.maybeNotify(ev)
  }

  /** Content-free push signal, sent on EVERY notify-worthy event. The relay
   *  decides whether to convert it to APNs based on proven client liveness —
   *  gating here on phoneConnected was wrong: iOS freezes the app's socket
   *  without closing it, so "connected" lied exactly when push mattered.
   *  Rides the plaintext control channel on purpose: the relay must read it
   *  to call APNs, so it never carries session content. */
  private maybeNotify(ev: SessionEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const kind = ev.event.kind
    const mapped =
      kind === 'permission-request' || kind === 'question-request'
        ? 'needs-approval'
        : kind === 'turn-complete'
          ? ev.event.isError
            ? 'turn-error'
            : 'turn-complete'
          : null
    if (!mapped) return
    try {
      this.ws.send(JSON.stringify({ t: 'notify', kind: mapped }))
    } catch {
      // best-effort; a lost push signal is not worth a reconnect cycle
    }
  }

  onSessionUpdated(session: SessionMeta): void {
    this.send({ t: 'event', channel: 'session-updated', payload: session })
  }

  dispose(): void {
    this.disposed = true
    this.disconnect()
    this.syncKeepAwake()
  }

  private identity(): BridgeIdentity {
    const raw = this.settings.getSetting(ID_KEY)
    if (raw) {
      try {
        return JSON.parse(raw) as BridgeIdentity
      } catch {
        // corrupt — regenerate below
      }
    }
    const fresh: BridgeIdentity = {
      deviceId: randomUUID(),
      pairSecret: randomBytes(32).toString('base64url')
    }
    this.settings.setSetting(ID_KEY, JSON.stringify(fresh))
    return fresh
  }

  private deriveKeys(): void {
    const secret = Buffer.from(this.identity().pairSecret, 'base64url')
    this.key = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO_E2E, 32))
    this.relayToken = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO_RELAY, 32)).toString(
      'base64url'
    )
  }

  private connect(): void {
    if (this.disposed || this.ws) return
    this.deriveKeys()
    const id = this.identity()
    const reset = this.settings.getSetting(NEEDS_RESET_KEY) === '1' ? '&reset=1' : ''
    const url = `${this.relayUrl()}/device/${id.deviceId}?t=${encodeURIComponent(this.relayToken)}${reset}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = (): void => {
      if (this.ws !== ws) return
      this.relayConnected = true
      this.backoffMs = BACKOFF_MIN_MS
      if (reset) this.settings.setSetting(NEEDS_RESET_KEY, '0')
      this.send({ t: 'hello', role: 'desktop', appVersion: this.appVersion })
      this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_MS)
      this.emitStatus()
    }
    ws.onmessage = (e: MessageEvent): void => {
      if (typeof e.data === 'string') {
        try {
          const frame = JSON.parse(e.data) as { t?: string; connected?: boolean }
          if (frame.t === 'peer') {
            this.phoneConnected = frame.connected === true
            if (!this.phoneConnected) this.subs.clear()
            this.emitStatus()
          }
        } catch {
          // not ours — ignore
        }
        return
      }
      this.onCipherFrame(Buffer.from(e.data as ArrayBuffer))
    }
    ws.onclose = (): void => {
      if (this.ws !== ws) return
      this.teardownSocket()
      if (!this.disposed && this.enabled) this.scheduleReconnect()
    }
    ws.onerror = (): void => {
      // onclose always follows; reconnect is handled there
    }
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    this.teardownSocket()
    try {
      ws?.close()
    } catch {
      // already closed
    }
  }

  private teardownSocket(): void {
    this.ws = null
    this.relayConnected = false
    this.phoneConnected = false
    this.subs.clear()
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.emitStatus()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return
    const delay = this.backoffMs + Math.random() * 500
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.enabled) this.connect()
    }, delay)
  }

  private onCipherFrame(buf: Buffer): void {
    let frame: BridgeClientFrame
    try {
      frame = JSON.parse(this.decrypt(buf).toString('utf8')) as BridgeClientFrame
    } catch {
      // wrong key (stale pairing) or garbage — never crash the bridge on it
      return
    }
    switch (frame.t) {
      case 'req':
        this.handleRequest(frame)
        break
      case 'sub':
        this.subs.add(frame.sessionId)
        break
      case 'unsub':
        this.subs.delete(frame.sessionId)
        break
      case 'ping':
        // echo so the phone's resume liveness probe gets a fast answer
        this.send({ t: 'ping' })
        break
      case 'hello':
        break
    }
  }

  private handleRequest(frame: { id: number; method: string; params: unknown[] }): void {
    const fn = this.api[frame.method]
    if (!fn) {
      this.send({ t: 'res', id: frame.id, ok: false, error: `unknown method: ${frame.method}` })
      return
    }
    Promise.resolve()
      .then(() => fn(...(frame.params as never[])))
      .then((result) => this.send({ t: 'res', id: frame.id, ok: true, result: result ?? null }))
      .catch((err) =>
        this.send({ t: 'res', id: frame.id, ok: false, error: err?.message ?? String(err) })
      )
  }

  private send(frame: BridgeDesktopFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.key) return
    // events are pointless with no phone listening; responses always go out
    if (frame.t === 'event' && !this.phoneConnected) return
    try {
      this.ws.send(this.encrypt(Buffer.from(JSON.stringify(frame), 'utf8')))
    } catch {
      // socket died mid-send; onclose reconnects
    }
  }

  /** Wire layout: iv(12) || ciphertext+tag — matches WebCrypto AES-GCM output. */
  private encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key!, iv)
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  }

  private decrypt(buf: Buffer): Buffer {
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const ct = buf.subarray(12, buf.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', this.key!, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  }

  private emitStatus(): void {
    try {
      this.onStatus(this.status())
    } catch {
      // status fan-out must never take the bridge down
    }
  }
}
