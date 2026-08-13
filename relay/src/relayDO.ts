import { DurableObject } from 'cloudflare:workers'

export interface RelayEnv {
  /** APNs push credentials — optional worker secrets; push is a no-op until set */
  APNS_TEAM_ID?: string
  APNS_KEY_ID?: string
  APNS_P8?: string
  APNS_TOPIC?: string
  APNS_ENV?: string
}

/**
 * One RelayDO per deviceId. Holds the desktop's WebSocket and up to
 * MAX_CLIENTS phone sockets, and pumps frames between the two sides verbatim.
 *
 * E2E frames are BINARY ws messages (opaque ciphertext — never inspected).
 * The only TEXT frames on the wire are relay-originated `{t:'peer',...}`
 * presence notices; they carry no user content.
 *
 * Auth: the desktop's first connection registers sha256(token) (TOFU); later
 * connections from either role must present the same token. `reset=1` from
 * the desktop re-registers — sent only on an explicit user re-pair, which is
 * how a lost/rotated pairSecret recovers the DO.
 */

type Role = 'desktop' | 'client'

const MAX_CLIENTS = 4

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class RelayDO extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const role: Role = url.pathname.startsWith('/device/') ? 'desktop' : 'client'
    const token = url.searchParams.get('t')
    if (!token) return new Response('missing token', { status: 401 })

    const tokenHash = await sha256Hex(token)
    const stored = await this.ctx.storage.get<string>('tokenHash')
    if (role === 'desktop') {
      if (!stored || url.searchParams.get('reset') === '1') {
        await this.ctx.storage.put('tokenHash', tokenHash)
      } else if (stored !== tokenHash) {
        return new Response('token mismatch', { status: 403 })
      }
    } else {
      if (!stored) return new Response('desktop has never connected', { status: 409 })
      if (stored !== tokenHash) return new Response('token mismatch', { status: 403 })
      if (this.sockets('client').length >= MAX_CLIENTS) {
        return new Response('too many clients', { status: 429 })
      }
    }

    if (role === 'desktop') {
      for (const ws of this.sockets('desktop')) ws.close(4000, 'replaced by newer desktop connection')
    }

    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], [role])
    this.notifyPresence()
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const role = this.roleOf(ws)
    if (typeof message === 'string') {
      await this.onControlFrame(role, message)
      return
    }
    for (const target of this.sockets(role === 'desktop' ? 'client' : 'desktop')) {
      try {
        target.send(message)
      } catch {
        // target went away mid-send; its close handler will fire
      }
    }
  }

  /** The plaintext channel: content-free push signals + APNs token registration. */
  private async onControlFrame(role: Role, message: string): Promise<void> {
    let frame: { t?: string; kind?: string; token?: string }
    try {
      frame = JSON.parse(message)
    } catch {
      return
    }
    if (role === 'client' && frame.t === 'apns' && typeof frame.token === 'string') {
      await this.ctx.storage.put('apnsToken', frame.token.slice(0, 200))
      return
    }
    if (role === 'desktop' && frame.t === 'notify' && typeof frame.kind === 'string') {
      if (this.sockets('client').length > 0) return // phone is live; it saw the real event
      await this.pushNotify(frame.kind)
    }
  }

  private async pushNotify(kind: string): Promise<void> {
    const env = this.env as RelayEnv
    if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_P8 || !env.APNS_TOPIC) return
    const token = await this.ctx.storage.get<string>('apnsToken')
    if (!token) return
    const last = (await this.ctx.storage.get<number>('lastPushAt')) ?? 0
    if (Date.now() - last < 15_000) return // batch storms of turn-completes
    await this.ctx.storage.put('lastPushAt', Date.now())

    const body =
      kind === 'needs-approval'
        ? 'An agent is waiting for your approval'
        : kind === 'turn-error'
          ? 'An agent turn failed'
          : 'An agent finished — ready for review'
    const host =
      env.APNS_ENV === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
    try {
      await fetch(`${host}/3/device/${token}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${await this.apnsJwt(env)}`,
          'apns-topic': env.APNS_TOPIC,
          'apns-push-type': 'alert',
          'apns-priority': '10'
        },
        body: JSON.stringify({ aps: { alert: { title: 'hang4r', body }, sound: 'default' } })
      })
    } catch {
      // push is best-effort; never let it disturb frame routing
    }
  }

  /** APNs provider JWTs are valid 20-60 min; mint at most once per 40 min. */
  private async apnsJwt(env: RelayEnv): Promise<string> {
    const cached = await this.ctx.storage.get<{ jwt: string; at: number }>('apnsJwt')
    if (cached && Date.now() - cached.at < 40 * 60_000) return cached.jwt
    const b64url = (data: ArrayBuffer | Uint8Array | string): string => {
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : data instanceof Uint8Array
            ? data
            : new Uint8Array(data)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }
    const pem = env.APNS_P8!.replace(/-----[A-Z ]+-----|\s/g, '')
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID }))
    const payload = b64url(
      JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })
    )
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(`${header}.${payload}`)
    )
    const jwt = `${header}.${payload}.${b64url(sig)}`
    await this.ctx.storage.put('apnsJwt', { jwt, at: Date.now() })
    return jwt
  }

  webSocketClose(ws: WebSocket): void {
    this.notifyPresence(ws)
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'error')
    } catch {
      // already closed
    }
    this.notifyPresence(ws)
  }

  private sockets(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role)
  }

  private roleOf(ws: WebSocket): Role {
    return this.ctx.getTags(ws).includes('desktop') ? 'desktop' : 'client'
  }

  /** Tell each side whether the other is currently connected. `closing` is
   *  excluded: the runtime may still list a socket during its own close event. */
  private notifyPresence(closing?: WebSocket): void {
    const live = (role: Role): WebSocket[] => this.sockets(role).filter((s) => s !== closing)
    const desktopUp = live('desktop').length > 0
    const clientsUp = live('client').length > 0
    for (const ws of live('client')) {
      this.sendText(ws, { t: 'peer', connected: desktopUp })
    }
    for (const ws of live('desktop')) {
      this.sendText(ws, { t: 'peer', connected: clientsUp })
    }
  }

  private sendText(ws: WebSocket, frame: { t: 'peer'; connected: boolean }): void {
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // socket closing; presence will re-broadcast on its close event
    }
  }
}
