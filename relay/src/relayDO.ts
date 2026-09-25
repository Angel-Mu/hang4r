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
// awake peers ping every 25s; silence past these means the socket is a corpse
const DESKTOP_STALE_MS = 40_000
const CLIENT_STALE_MS = 90_000

interface SocketMeta {
  seenAt: number
}

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
    }

    if (role === 'desktop') {
      for (const ws of this.sockets('desktop')) ws.close(4000, 'replaced by newer desktop connection')
    } else {
      const pruned = this.pruneClients()
      // a full house is usually frozen iOS sockets from past sessions; the
      // newcomer is the one proving it's alive, so evict the quietest instead
      // (closed sockets can still be listed until their close event runs)
      const clients = this.sockets('client').filter((c) => !pruned.includes(c))
      if (clients.length >= MAX_CLIENTS) {
        const quietest = clients.reduce((a, b) => (this.seenAt(a) <= this.seenAt(b) ? a : b))
        console.log('relay: evicting quietest client to admit a new one')
        this.closeQuietly(quietest, 4002, 'evicted for a newer client')
      }
    }

    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], [role])
    pair[1].serializeAttachment({ seenAt: Date.now() } satisfies SocketMeta)
    this.notifyPresence()
    // while phones are watching, wake periodically to catch a desktop that
    // died without a TCP goodbye (power-off, kernel panic, network yank)
    if (this.sockets('client').length > 0) await this.ctx.storage.setAlarm(Date.now() + 35_000)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const role = this.roleOf(ws)
    // liveness lives on the socket attachment, not in storage: a storage put
    // per frame burns the DO's daily row-write quota, and once that's spent
    // every put throws — which used to abort forwarding.
    ws.serializeAttachment({ seenAt: Date.now() } satisfies SocketMeta)
    if (role === 'client') this.checkDesktopStale()
    if (typeof message === 'string') {
      try {
        await this.onControlFrame(role, message)
      } catch (err) {
        console.log('relay: control frame failed', String(err))
      }
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
    let frame: { t?: string; kind?: string; token?: string; sessionId?: string; title?: string }
    try {
      frame = JSON.parse(message)
    } catch {
      return
    }
    if (role === 'client' && frame.t === 'apns' && typeof frame.token === 'string') {
      if (frame.token) {
        const tokens = await this.apnsTokens()
        if (!tokens.includes(frame.token)) {
          tokens.push(frame.token.slice(0, 200))
          await this.ctx.storage.put('apnsTokens', tokens.slice(-8))
        }
      }
      return
    }
    if (role === 'client' && frame.t === 'apns-remove' && typeof frame.token === 'string') {
      const tokens = (await this.apnsTokens()).filter((t) => t !== frame.token)
      await this.ctx.storage.put('apnsTokens', tokens)
      return
    }
    if (role === 'desktop' && frame.t === 'notify' && typeof frame.kind === 'string') {
      const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId.slice(0, 64) : undefined
      const title = typeof frame.title === 'string' ? frame.title.slice(0, 80) : undefined
      // a phone counts as "watching" only when it PROVED liveness recently
      // (awake phones ping every 25s); a merely-open socket is not enough
      const clientLive = this.sockets('client').some((c) => Date.now() - this.seenAt(c) < 40_000)
      if (clientLive) return
      await this.pushNotify(frame.kind, sessionId, title)
    }
  }

  private async pushNotify(kind: string, sessionId?: string, title?: string): Promise<void> {
    const env = this.env as RelayEnv
    if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_P8 || !env.APNS_TOPIC) return
    const tokens = await this.apnsTokens()
    if (tokens.length === 0) return
    const last = (await this.ctx.storage.get<number>('lastPushAt')) ?? 0
    if (Date.now() - last < 15_000) return // batch storms of turn-completes
    await this.ctx.storage.put('lastPushAt', Date.now())

    const who = title ? `“${title}”` : 'An agent'
    const body =
      kind === 'needs-approval'
        ? `${who} is waiting for your approval`
        : kind === 'turn-error'
          ? `${who} failed`
          : `${who} finished — ready for review`
    const host =
      env.APNS_ENV === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
    // every paired device gets the push (iPhone AND iPad); tokens APNs
    // declares dead are pruned so the set stays clean
    const jwt = await this.apnsJwt(env)
    const dead: string[] = []
    for (const token of tokens) {
      try {
        const res = await fetch(`${host}/3/device/${token}`, {
          method: 'POST',
          headers: {
            authorization: `bearer ${jwt}`,
            'apns-topic': env.APNS_TOPIC,
            'apns-push-type': 'alert',
            'apns-priority': '10'
          },
          body: JSON.stringify({
            aps: { alert: { title: 'hang4r', body }, sound: 'default' },
            ...(sessionId ? { sessionId } : {})
          })
        })
        if (res.status === 410 || res.status === 400) dead.push(token)
      } catch {
        // push is best-effort; never let it disturb frame routing
      }
    }
    if (dead.length) {
      await this.ctx.storage.put(
        'apnsTokens',
        tokens.filter((t) => !dead.includes(t))
      )
    }
  }

  /** token set, folding in the legacy single-token slot once */
  private async apnsTokens(): Promise<string[]> {
    const tokens = (await this.ctx.storage.get<string[]>('apnsTokens')) ?? []
    const legacy = await this.ctx.storage.get<string>('apnsToken')
    if (legacy) {
      await this.ctx.storage.delete('apnsToken')
      if (!tokens.includes(legacy)) {
        tokens.push(legacy)
        await this.ctx.storage.put('apnsTokens', tokens)
      }
    }
    return tokens
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

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    console.log(`relay: ${this.roleOf(ws)} closed ${code} ${reason}`)
    this.notifyPresence(ws)
  }

  async alarm(): Promise<void> {
    this.checkDesktopStale()
    this.pruneClients()
    if (this.sockets('client').length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 35_000)
    }
  }

  /** Frozen iOS sockets never close on their own and would hold client slots
   *  forever; an awake phone reconnects on resume anyway. */
  private pruneClients(): WebSocket[] {
    const stale = this.sockets('client').filter((ws) => Date.now() - this.seenAt(ws) > CLIENT_STALE_MS)
    for (const ws of stale) this.closeQuietly(ws, 4003, `no frames for ${CLIENT_STALE_MS / 1000}s`)
    return stale
  }

  private seenAt(ws: WebSocket): number {
    return (ws.deserializeAttachment() as SocketMeta | null)?.seenAt ?? 0
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // already closed
    }
  }

  /** A desktop socket that hasn't produced a frame in 40s is a corpse: tell
   *  the phones the truth and close it so a live desktop can reconnect. */
  private checkDesktopStale(): void {
    const desktops = this.sockets('desktop')
    if (desktops.length === 0) return
    if (desktops.some((ws) => Date.now() - this.seenAt(ws) < DESKTOP_STALE_MS)) return
    console.log('relay: closing silent desktop')
    // closing a corpse still fires webSocketClose → presence update
    for (const ws of desktops) this.closeQuietly(ws, 4001, 'no frames for 40s — presumed dead')
    for (const ws of this.sockets('client')) {
      this.sendText(ws, { t: 'peer', connected: false })
    }
  }

  webSocketError(ws: WebSocket, err: unknown): void {
    console.log(`relay: ${this.roleOf(ws)} socket error`, String(err))
    this.closeQuietly(ws, 1011, 'error')
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
