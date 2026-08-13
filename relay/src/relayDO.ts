import { DurableObject } from 'cloudflare:workers'

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

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const role = this.roleOf(ws)
    if (typeof message === 'string') return // text is relay-control only; peers never send it
    for (const target of this.sockets(role === 'desktop' ? 'client' : 'desktop')) {
      try {
        target.send(message)
      } catch {
        // target went away mid-send; its close handler will fire
      }
    }
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
