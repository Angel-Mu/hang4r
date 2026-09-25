import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { networkInterfaces } from 'os'
import { BrowserWindow, powerMonitor, powerSaveBlocker } from 'electron'
// not the global WebSocket: only `ws` can send protocol pings, and the relay's
// edge answers those — the one reply a desktop gets with no phone connected
import WebSocket, { type RawData } from 'ws'
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
import { slimEventForPhone } from './bridgeHistory'
import {
  DIAG_LOG_MAX,
  LINK_CONNECT_TIMEOUT_MS,
  LINK_SILENCE_MS,
  emptyDiagnostics,
  linkIsSilent,
  pushLog,
  type LinkDiagnostics,
  type LinkLogEntry
} from '../../shared/bridgeLink'

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
/** grace before a push leaves for the phones — seen-on-desktop cancels it */
const NOTIFY_DELAY_MS = 30_000
/** approvals escalate even while the desktop is focused, just slower */
const NOTIFY_DELAY_FOCUSED_APPROVAL_MS = 60_000
/** the desktop sidebar's own re-read interval for live work */
const LIVE_WORK_POLL_MS = 5_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** how long a wake-up probe waits for any frame before replacing the socket */
const PROBE_MS = 5_000
const NET_POLL_MS = 5_000

/** e2e: `ping=1000,silence=4000,connect=15000` */
function linkTiming(): { ping: number; silence: number; connect: number } {
  const t = { ping: PING_MS, silence: LINK_SILENCE_MS, connect: LINK_CONNECT_TIMEOUT_MS }
  for (const spec of (process.env.HANG4R_TEST_BRIDGE_TIMING ?? '').split(',')) {
    const [k, v] = spec.split('=')
    if (k in t && Number(v) > 0) t[k as keyof typeof t] = Number(v)
  }
  return t
}

/** Routable IPv4 addresses only: link-local and AWDL churn would reconnect
 *  for nothing, while a Wi-Fi/VPN/Ethernet switch always changes this. */
function networkSignature(): string {
  const addrs: string[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4' || a.address.startsWith('169.254.')) continue
      addrs.push(`${name}=${a.address}`)
    }
  }
  return addrs.sort().join(',')
}

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
  private pendingNotifies = new Map<string, ReturnType<typeof setTimeout>>()
  private liveWorkTimer: ReturnType<typeof setInterval> | null = null
  private lastLiveWork: string | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private netTimer: ReturnType<typeof setInterval> | null = null
  private netSignature = networkSignature()
  private timing = linkTiming()
  /** e2e: the first socket hears nothing — a link that died without a close */
  private deafNext = process.env.HANG4R_TEST_BRIDGE_DEAF === '1'
  private everConnected = false
  private diag: LinkDiagnostics = emptyDiagnostics('desktop')
  private diagWrite: Promise<void> | null = null
  private diagDirty = false
  private onResume = (): void => this.wake('system resumed', false)
  private onUnlock = (): void => this.wake('screen unlocked', true)

  constructor(
    private settings: SettingsLike,
    private api: Record<string, (...args: never[]) => unknown>,
    private appVersion: string,
    private onStatus: (s: BridgeStatus) => void,
    private titleFor: (sessionId: string) => string | null = () => null,
    private liveWork: () => Promise<string[]> = async () => [],
    private diagPath: string | null = null
  ) {
    this.loadLog()
    this.diag.state = this.enabled ? 'connecting' : 'off'
    this.diag.stateSince = Date.now()
    powerMonitor.on('resume', this.onResume)
    powerMonitor.on('unlock-screen', this.onUnlock)
    this.netTimer = setInterval(() => this.checkNetwork(), NET_POLL_MS)
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
    this.log(on ? 'phone access turned on' : 'phone access turned off')
    if (on) this.connect()
    else {
      this.disconnect()
      this.setLinkState('off')
    }
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
    this.log('re-paired: new pairing secret, every phone must scan the new QR')
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
    const forPhone =
      (kind === 'block-delta' || kind === 'usage') && !this.subs.has(ev.sessionId)
        ? null
        : slimEventForPhone(ev.event)
    if (forPhone) {
      this.send({
        t: 'event',
        channel: 'agent-event',
        payload: forPhone === ev.event ? ev : { ...ev, event: forPhone }
      })
    }
    // an approval answered ANYWHERE makes its pending push moot
    if (kind === 'permission-resolved' || kind === 'question-resolved') {
      this.cancelNotify(ev.sessionId)
    }
    this.maybeNotify(ev)
  }

  /** cancel a session's held push (or every held push) — it was seen in time */
  cancelNotify(sessionId?: string): void {
    if (sessionId) {
      const t = this.pendingNotifies.get(sessionId)
      if (t) clearTimeout(t)
      this.pendingNotifies.delete(sessionId)
      return
    }
    for (const t of this.pendingNotifies.values()) clearTimeout(t)
    this.pendingNotifies.clear()
  }

  /** tell every phone these sessions were seen somewhere (E2E event frame) */
  sendSeen(sessionIds: string[]): void {
    for (const id of sessionIds) {
      this.cancelNotify(id)
      this.send({ t: 'seen', sessionId: id })
    }
  }

  /** the desktop flagged this session finished-unseen — phones light its bell */
  sendUnseen(sessionId: string): void {
    this.send({ t: 'unseen', sessionId })
  }

  sendTranscriptReset(sessionId: string): void {
    this.send({ t: 'transcript-reset', sessionId })
  }

  /** Content-free push signal, sent on EVERY notify-worthy event. The relay
   *  decides whether to convert it to APNs based on proven client liveness —
   *  gating here on phoneConnected was wrong: iOS freezes the app's socket
   *  without closing it, so "connected" lied exactly when push mattered.
   *  Rides the plaintext control channel on purpose: the relay must read it
   *  to call APNs, so it never carries session content. */
  private maybeNotify(ev: SessionEvent): void {
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
    const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
    // you're looking at the desktop: a finished turn needs no phone buzz at
    // all; a pending approval still escalates, just on a longer fuse
    if (focused && mapped !== 'needs-approval') return
    const delay = focused ? NOTIFY_DELAY_FOCUSED_APPROVAL_MS : NOTIFY_DELAY_MS
    this.cancelNotify(ev.sessionId)
    const sessionId = ev.sessionId
    this.pendingNotifies.set(
      sessionId,
      setTimeout(() => {
        this.pendingNotifies.delete(sessionId)
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
        try {
          const title = this.titleFor(sessionId)?.slice(0, 60)
          this.ws.send(
            JSON.stringify({ t: 'notify', kind: mapped, sessionId, ...(title ? { title } : {}) })
          )
        } catch {
          // best-effort; a lost push signal is not worth a reconnect cycle
        }
      }, delay)
    )
  }

  onSessionUpdated(session: SessionMeta): void {
    this.send({ t: 'event', channel: 'session-updated', payload: session })
    if (this.phoneConnected) void this.pollLiveWork()
  }

  /** Only while a phone listens: answering probes processes. */
  private syncLiveWorkPolling(): void {
    if (this.phoneConnected && !this.liveWorkTimer) {
      this.lastLiveWork = null
      void this.pollLiveWork()
      this.liveWorkTimer = setInterval(() => void this.pollLiveWork(), LIVE_WORK_POLL_MS)
    } else if (!this.phoneConnected && this.liveWorkTimer) {
      clearInterval(this.liveWorkTimer)
      this.liveWorkTimer = null
    }
  }

  private async pollLiveWork(): Promise<void> {
    let ids: string[]
    try {
      ids = [...(await this.liveWork())].sort()
    } catch {
      return
    }
    const key = ids.join(',')
    if (key === this.lastLiveWork || !this.phoneConnected) return
    this.lastLiveWork = key
    this.send({ t: 'live-work', ids })
  }

  /** Replace the relay socket now, keeping the pairing. */
  reconnect(reason = 'reconnect requested'): BridgeStatus {
    if (!this.enabled || this.disposed) return this.status()
    if (!this.ws) this.log(reason)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.backoffMs = BACKOFF_MIN_MS
    this.dropSocket(reason)
    this.connect()
    return this.status()
  }

  diagnostics(): LinkDiagnostics {
    return { ...this.diag, log: [...this.diag.log] }
  }

  /** After sleep the socket is dead for sure; after an unlock or a network
   *  switch it may be fine — ask it first, replace it only if it stays mute. */
  private wake(reason: string, probeFirst: boolean): void {
    if (!this.enabled || this.disposed) return
    const ws = this.ws
    if (!probeFirst || !ws || ws.readyState !== WebSocket.OPEN) {
      if (ws?.readyState === WebSocket.CONNECTING) return
      this.reconnect(reason)
      return
    }
    this.log(`${reason}: probing the relay link`)
    const before = this.diag.lastRxAt
    this.pingNow()
    setTimeout(() => {
      if (this.ws === ws && this.diag.lastRxAt === before) {
        this.reconnect(`${reason}: no answer in ${PROBE_MS / 1000}s`)
      }
    }, PROBE_MS)
  }

  private checkNetwork(): void {
    const sig = networkSignature()
    if (sig === this.netSignature) return
    this.netSignature = sig
    this.wake('network changed', true)
  }

  dispose(): void {
    this.disposed = true
    this.cancelNotify()
    this.disconnect()
    this.syncKeepAwake()
    powerMonitor.off('resume', this.onResume)
    powerMonitor.off('unlock-screen', this.onUnlock)
    if (this.netTimer) clearInterval(this.netTimer)
    this.netTimer = null
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
    this.relayToken = Buffer.from(
      hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO_RELAY, 32)
    ).toString('base64url')
  }

  private connect(): void {
    if (this.disposed || this.ws) return
    this.deriveKeys()
    const id = this.identity()
    const reset = this.settings.getSetting(NEEDS_RESET_KEY) === '1' ? '&reset=1' : ''
    const url = `${this.relayUrl()}/device/${id.deviceId}?t=${encodeURIComponent(this.relayToken)}${reset}`
    if (this.everConnected) this.diag.reconnects++
    this.everConnected = true
    this.setLinkState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.log(`connect failed: ${err instanceof Error ? err.message : String(err)}`)
      this.setLinkState('waiting')
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    const deaf = this.deafNext
    this.deafNext = false
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (this.ws !== ws || ws.readyState === WebSocket.OPEN) return
      this.dropSocket(`connect timed out after ${this.timing.connect / 1000}s`)
      this.scheduleReconnect()
    }, this.timing.connect)
    ws.on('open', () => {
      if (this.ws !== ws) return
      this.clearConnectTimer()
      this.relayConnected = true
      this.backoffMs = BACKOFF_MIN_MS
      if (reset) this.settings.setSetting(NEEDS_RESET_KEY, '0')
      this.diag.lastRxAt = Date.now()
      this.setLinkState('open')
      this.log('relay socket open')
      this.send({ t: 'hello', role: 'desktop', appVersion: this.appVersion })
      this.pingTimer = setInterval(() => this.pingNow(), this.timing.ping)
      this.watchdogTimer = setInterval(
        () => {
          if (this.ws !== ws || !linkIsSilent(this.diag.lastRxAt, Date.now(), this.timing.silence))
            return
          this.dropSocket(`no frames for ${Math.round(this.timing.silence / 1000)}s`)
          this.scheduleReconnect()
        },
        Math.min(5_000, this.timing.silence / 4)
      )
      this.emitStatus()
    })
    ws.on('pong', () => {
      if (this.ws === ws && !deaf) this.diag.lastRxAt = Date.now()
    })
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (this.ws !== ws || deaf) return
      this.diag.lastRxAt = Date.now()
      const data = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw)
      if (!isBinary) {
        try {
          const frame = JSON.parse(data.toString('utf8')) as { t?: string; connected?: boolean }
          if (frame.t === 'peer') {
            const was = this.phoneConnected
            this.phoneConnected = frame.connected === true
            if (was !== this.phoneConnected) {
              this.log(this.phoneConnected ? 'phone connected' : 'no phone connected')
              // our hello went out before this phone arrived
              if (this.phoneConnected) {
                this.send({ t: 'hello', role: 'desktop', appVersion: this.appVersion })
              }
            }
            if (!this.phoneConnected) this.subs.clear()
            this.syncLiveWorkPolling()
            this.emitStatus()
          }
        } catch {
          // not ours — ignore
        }
        return
      }
      this.onCipherFrame(data)
    })
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== ws) return
      this.diag.lastClose = { code, reason: reason.toString('utf8'), at: Date.now() }
      this.log(`relay socket closed: ${code}${reason.length ? ` ${reason.toString('utf8')}` : ''}`)
      this.teardownSocket()
      if (!this.disposed && this.enabled) {
        this.setLinkState('waiting')
        this.scheduleReconnect()
      }
    })
    ws.on('error', (err: Error) => {
      // a listener is mandatory (ws throws otherwise); close follows and reconnects
      if (this.ws === ws) this.log(`socket error: ${err.message}`)
    })
  }

  private pingNow(): void {
    this.send({ t: 'ping' })
    try {
      this.ws?.ping()
    } catch {
      // not open; the watchdog or close handler takes it from here
    }
  }

  /** Abandon the current socket without waiting for a close handshake a dead
   *  link would never deliver. */
  private dropSocket(reason: string): void {
    const ws = this.ws
    if (!ws) return
    this.diag.lastClose = { code: 0, reason, at: Date.now() }
    this.log(`dropped the relay socket: ${reason}`)
    this.teardownSocket()
    this.setLinkState('waiting')
    try {
      ws.terminate()
    } catch {
      // already gone
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
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
    this.syncLiveWorkPolling()
    this.clearConnectTimer()
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
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

  private setLinkState(state: string): void {
    if (this.diag.state === state) return
    this.diag.state = state
    this.diag.stateSince = Date.now()
  }

  private log(msg: string): void {
    pushLog(this.diag.log, msg)
    this.saveLog()
  }

  private loadLog(): void {
    if (!this.diagPath) return
    try {
      const saved = JSON.parse(readFileSync(this.diagPath, 'utf8')) as LinkLogEntry[]
      if (Array.isArray(saved)) this.diag.log = saved.slice(-DIAG_LOG_MAX)
    } catch {
      // first run or unreadable — start fresh
    }
  }

  private saveLog(): void {
    if (!this.diagPath) return
    this.diagDirty = true
    if (this.diagWrite) return
    const path = this.diagPath
    const flush = async (): Promise<void> => {
      while (this.diagDirty) {
        this.diagDirty = false
        await writeFile(path, JSON.stringify(this.diag.log)).catch(() => {})
      }
      this.diagWrite = null
    }
    this.diagWrite = flush()
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
        if (this.diag.peerVersion !== frame.appVersion) this.log(`phone app ${frame.appVersion}`)
        this.diag.peerVersion = frame.appVersion
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
      this.diag.lastSentAt = Date.now()
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
