export { RelayDO } from './relayDO'

export interface Env {
  RELAY: DurableObjectNamespace
}

const PATH_RE = /^\/(device|client)\/([0-9a-zA-Z-]{8,64})$/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/health') return new Response('ok')

    const m = PATH_RE.exec(url.pathname)
    if (!m) return new Response('not found', { status: 404 })
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket required', { status: 426 })
    }
    // idFromName: same deviceId always lands on the same DO instance.
    return env.RELAY.get(env.RELAY.idFromName(m[2])).fetch(req)
  }
} satisfies ExportedHandler<Env>
