import {
  parsePairingUrl,
  type BridgeClientFrame,
  type BridgeDesktopFrame,
  type BridgePairing
} from '@shared/bridge'
import type { SessionEvent, SessionMeta } from '@shared/protocol'
import { decryptFrame, deriveKeys, encryptFrame, type BridgeKeys } from './crypto'

export type ConnectionState = 'idle' | 'connecting' | 'relay' | 'online'

export interface BridgeCallbacks {
  onState(state: ConnectionState): void
  onAgentEvent(ev: SessionEvent): void
  onSessionUpdated(session: SessionMeta): void
}

const PING_MS = 25_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 15_000

/**
 * The phone side of the bridge: relay ws + E2E frames + request/response.
 * 'relay' state = reached the relay but the desktop is offline; 'online' =
 * the desktop is reachable and calls will resolve.
 */
export class BridgeClient {
  private ws: WebSocket | null = null
  private keys: BridgeKeys | null = null
  private nextId = 1
  private waiters = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
  >()
  private subs = new Set<string>()
  private backoffMs = BACKOFF_MIN_MS
  private reconnectTimer: number | null = null
  private pingTimer: number | null = null
  private stopped = true
  state: ConnectionState = 'idle'

  constructor(
    private pairing: BridgePairing,
    private cb: BridgeCallbacks
  ) {}

  static fromUrl(url: string, cb: BridgeCallbacks): BridgeClient | null {
    const pairing = parsePairingUrl(url.trim())
    return pairing ? new BridgeClient(pairing, cb) : null
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.teardown('idle')
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
    this.ws = null
  }

  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    if (this.state !== 'online') throw new Error('desktop is offline')
    const id = this.nextId++
    const frame: BridgeClientFrame = { t: 'req', id, method, params }
    await this.send(frame)
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`${method} timed out`))
      }, 20_000)
      this.waiters.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    })
  }

  sub(sessionId: string): void {
    this.subs.add(sessionId)
    void this.send({ t: 'sub', sessionId })
  }

  unsub(sessionId: string): void {
    this.subs.delete(sessionId)
    void this.send({ t: 'unsub', sessionId })
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.cb.onState(state)
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ws) return
    this.setState('connecting')
    this.keys ??= await deriveKeys(this.pairing.secret)
    const url = `${this.pairing.relay}/client/${this.pairing.deviceId}?t=${encodeURIComponent(
      this.keys.relayToken
    )}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = (): void => {
      if (this.ws !== ws) return
      this.backoffMs = BACKOFF_MIN_MS
      this.setState('relay')
      void this.send({ t: 'hello', role: 'client', appVersion: '0.1.0' })
      this.pingTimer = window.setInterval(() => void this.send({ t: 'ping' }), PING_MS)
    }
    ws.onmessage = (e: MessageEvent): void => {
      if (typeof e.data === 'string') {
        try {
          const ctl = JSON.parse(e.data) as { t?: string; connected?: boolean }
          if (ctl.t === 'peer') {
            if (ctl.connected) {
              this.setState('online')
              // re-subscribe: the desktop clears subs when it saw us drop
              for (const s of this.subs) void this.send({ t: 'sub', sessionId: s })
            } else {
              this.failInflight('desktop went offline')
              this.setState('relay')
            }
          }
        } catch {
          // not a relay control frame — ignore
        }
        return
      }
      void this.onCipherFrame(e.data as ArrayBuffer)
    }
    ws.onclose = (): void => {
      if (this.ws !== ws) return
      this.ws = null
      this.teardown(this.stopped ? 'idle' : 'connecting')
      if (!this.stopped) this.scheduleReconnect()
    }
  }

  private teardown(state: ConnectionState): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.failInflight('connection lost')
    this.setState(state)
  }

  private failInflight(reason: string): void {
    for (const [, w] of this.waiters) {
      clearTimeout(w.timer)
      w.reject(new Error(reason))
    }
    this.waiters.clear()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = this.backoffMs + Math.random() * 400
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private async onCipherFrame(buf: ArrayBuffer): Promise<void> {
    let frame: BridgeDesktopFrame
    try {
      frame = JSON.parse(await decryptFrame(this.keys!.e2e, buf)) as BridgeDesktopFrame
    } catch {
      return
    }
    switch (frame.t) {
      case 'res': {
        const w = this.waiters.get(frame.id)
        if (!w) return
        this.waiters.delete(frame.id)
        clearTimeout(w.timer)
        if (frame.ok) w.resolve(frame.result)
        else w.reject(new Error(frame.error))
        break
      }
      case 'event':
        if (frame.channel === 'agent-event') this.cb.onAgentEvent(frame.payload)
        else this.cb.onSessionUpdated(frame.payload)
        break
      case 'hello':
        this.setState('online')
        break
      case 'ping':
        break
    }
  }

  private async send(frame: BridgeClientFrame): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keys) return
    try {
      this.ws.send(await encryptFrame(this.keys.e2e, JSON.stringify(frame)))
    } catch {
      // socket died mid-send; onclose reconnects
    }
  }
}
