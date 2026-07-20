/**
 * GET/POST /api/unsubscribe?e=<email>&t=<token> — one-click unsubscribe.
 * The token is HMAC-SHA256(email, UNSUB_SECRET) so links can't be forged for
 * other people's addresses. GET shows a tiny confirmation page; POST is the
 * RFC 8058 one-click endpoint referenced by the List-Unsubscribe header.
 * Marks the contact unsubscribed in KV (source of truth) and in the Resend
 * audience (so dashboard Broadcasts skip them too).
 */

interface Env {
  WAITLIST: KVNamespace
  RESEND_API_KEY: string
  RESEND_AUDIENCE_ID: string
  UNSUB_SECRET: string
}

const RESEND = 'https://api.resend.com'

export async function unsubToken(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(email))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

async function markUnsubscribed(env: Env, email: string): Promise<void> {
  const prev = await env.WAITLIST.get(email)
  let value: Record<string, unknown> = {}
  try {
    value = prev ? JSON.parse(prev) : {}
  } catch {
    /* keep {} */
  }
  value.unsubscribed = true
  value.unsubscribedAt = new Date().toISOString()
  await env.WAITLIST.put(email, JSON.stringify(value))

  // best-effort mirror into the Resend audience
  const res = await fetch(`${RESEND}/audiences/${env.RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ unsubscribed: true })
  })
  if (!res.ok) {
    console.error('resend unsubscribe mirror error', res.status, await res.text())
  }
}

async function validate(env: Env, request: Request): Promise<string | null> {
  const url = new URL(request.url)
  const email = (url.searchParams.get('e') ?? '').trim().toLowerCase()
  const token = url.searchParams.get('t') ?? ''
  if (!email || !token) return null
  const expected = await unsubToken(email, env.UNSUB_SECRET)
  return token === expected ? email : null
}

const page = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} — hang4r</title>
<style>body{background:#0b0b0f;color:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:420px;text-align:center;padding:24px}h1{font-size:22px;letter-spacing:-.02em}p{color:#9a9ab5;font-size:15px;line-height:1.6}
a{color:#a3a3fc}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const email = await validate(env, request)
  if (!email) {
    return page('That link doesn’t work', `<p>The unsubscribe link is invalid or incomplete. If you want off the list, write to <a href="mailto:hello@hang4r.dev">hello@hang4r.dev</a>.</p>`)
  }
  await markUnsubscribed(env, email)
  return page(
    'You’re unsubscribed',
    `<p>${email} won’t receive any more hang4r emails. Change your mind? Just sign up again at <a href="https://hang4r.dev/">hang4r.dev</a>.</p>`
  )
}

// RFC 8058 one-click (List-Unsubscribe-Post) — mail clients POST here silently
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const email = await validate(env, request)
  if (!email) return new Response('invalid', { status: 400 })
  await markUnsubscribed(env, email)
  return new Response('ok')
}
