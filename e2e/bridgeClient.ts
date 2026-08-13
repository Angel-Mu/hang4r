import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import {
  HKDF_INFO_E2E,
  HKDF_INFO_RELAY,
  HKDF_SALT,
  parsePairingUrl,
  type BridgeClientFrame,
  type BridgeDesktopFrame
} from '../src/shared/bridge'

/**
 * A "phone" for tests: the reference client implementation of the bridge
 * protocol (pairing-URL → HKDF keys → relay ws → encrypted frames). The
 * mobile app mirrors this with WebCrypto.
 */
export class FakePhone {
  private ws!: WebSocket
  private key: Buffer
  private token: string
  private nextId = 1
  private waiters = new Map<number, (f: Extract<BridgeDesktopFrame, { t: 'res' }>) => void>()
  private eventQueue: BridgeDesktopFrame[] = []
  private eventWaiters: ((f: BridgeDesktopFrame) => void)[] = []
  private relayUrl: string
  private deviceId: string
  peerConnected = false

  constructor(pairingUrl: string) {
    const p = parsePairingUrl(pairingUrl)
    if (!p) throw new Error('bad pairing url: ' + pairingUrl)
    const secret = Buffer.from(p.secret, 'base64url')
    this.key = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO_E2E, 32))
    this.token = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO_RELAY, 32)).toString(
      'base64url'
    )
    this.relayUrl = p.relay
    this.deviceId = p.deviceId
  }

  /** The relay 409s a client whose desktop hasn't registered yet — retry. */
  async connectWithRetry(attempts = 10, delayMs = 1000): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.connect()
        return
      } catch {
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    throw new Error('phone could not reach the relay (desktop never registered?)')
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.relayUrl}/client/${this.deviceId}?t=${encodeURIComponent(this.token)}`
      this.ws = new WebSocket(url)
      this.ws.binaryType = 'arraybuffer'
      this.ws.onopen = (): void => {
        this.send({ t: 'hello', role: 'client', appVersion: 'e2e' })
        resolve()
      }
      this.ws.onerror = (): void => reject(new Error('phone ws failed to connect'))
      this.ws.onmessage = (e: MessageEvent): void => {
        if (typeof e.data === 'string') {
          const ctl = JSON.parse(e.data) as { t: string; connected?: boolean }
          if (ctl.t === 'peer') this.peerConnected = ctl.connected === true
          return
        }
        const frame = JSON.parse(
          this.decrypt(Buffer.from(e.data as ArrayBuffer)).toString('utf8')
        ) as BridgeDesktopFrame
        if (frame.t === 'res') {
          const w = this.waiters.get(frame.id)
          if (w) {
            this.waiters.delete(frame.id)
            w(frame)
          }
          return
        }
        if (frame.t === 'ping' || frame.t === 'hello') return
        const ew = this.eventWaiters.shift()
        if (ew) ew(frame)
        else this.eventQueue.push(frame)
      }
    })
  }

  call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`bridge call timed out: ${method}`))
      }, 15_000)
      this.waiters.set(id, (res) => {
        clearTimeout(t)
        if (res.ok) resolve(res.result as T)
        else reject(new Error(res.error))
      })
      this.send({ t: 'req', id, method, params })
    })
  }

  sub(sessionId: string): void {
    this.send({ t: 'sub', sessionId })
  }

  /** Next forwarded event matching `pred` (already-received ones first). */
  nextEvent(
    pred: (f: BridgeDesktopFrame) => boolean,
    timeoutMs = 20_000
  ): Promise<BridgeDesktopFrame> {
    const idx = this.eventQueue.findIndex(pred)
    if (idx >= 0) return Promise.resolve(this.eventQueue.splice(idx, 1)[0])
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for bridge event')), timeoutMs)
      const check = (f: BridgeDesktopFrame): void => {
        if (pred(f)) {
          clearTimeout(t)
          resolve(f)
        } else {
          this.eventQueue.push(f)
          this.eventWaiters.push(check)
        }
      }
      this.eventWaiters.push(check)
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }

  private send(frame: BridgeClientFrame): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const plain = Buffer.from(JSON.stringify(frame), 'utf8')
    this.ws.send(Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]))
  }

  private decrypt(buf: Buffer): Buffer {
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const ct = buf.subarray(12, buf.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  }
}
