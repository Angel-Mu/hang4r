/**
 * POST /api/waitlist — Cloudflare Pages Function.
 * Stores the signup in the WAITLIST KV namespace (source of truth), mirrors it
 * into the Resend audience (so dashboard Broadcasts reach the list), and sends
 * the confirmation email through Resend.
 * Bindings: WAITLIST (KV) + RESEND_AUDIENCE_ID (wrangler.toml) · RESEND_API_KEY
 * (Pages secret, full-access).
 */

import { unsubToken } from './unsubscribe'

interface Env {
  WAITLIST: KVNamespace
  RESEND_API_KEY: string
  RESEND_AUDIENCE_ID: string
  UNSUB_SECRET: string
}

const RESEND = 'https://api.resend.com'
const FROM = 'hang4r <hello@hang4r.dev>'

// pragmatic RFC-ish check; Resend validates for real on its side
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const CONFIRMATION_SUBJECT = "you're on the hang4r list"

const confirmationHtml = (email: string, unsubUrl: string): string => `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a24;">
    <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
      <div style="background:#ffffff;border:1px solid #e4e4ee;border-radius:12px;padding:36px 32px;">
        <p style="font-family:ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#7c7cf0;margin:0 0 18px;">hang4r · updates</p>
        <h1 style="font-size:24px;line-height:1.25;letter-spacing:-0.02em;margin:0 0 14px;">You're subscribed.</h1>
        <p style="font-size:15px;line-height:1.65;color:#43435a;margin:0 0 12px;">
          Thanks for subscribing to <strong>hang4r</strong> updates — the free desktop agents
          window that runs parallel <strong>Claude Code</strong>, <strong>Codex</strong>, and
          <strong>Cursor</strong> sessions in isolated git worktrees, on the subscription you
          already pay for.
        </p>
        <p style="font-size:15px;line-height:1.65;color:#43435a;margin:0 0 12px;">
          What to expect: release notes and new-feature announcements, and nothing else —
          no drip campaigns, one-click unsubscribe. The app itself is a free download at
          <a href="https://hang4r.dev/" style="color:#5b5bd6;">hang4r.dev</a>, no list required.
        </p>
        <p style="font-size:15px;line-height:1.65;color:#43435a;margin:0 0 24px;">
          Meanwhile, the <a href="https://hang4r.dev/blog/" style="color:#5b5bd6;">blog</a> covers
          how we run parallel agents day to day, and the
          <a href="https://hang4r.dev/#compare" style="color:#5b5bd6;">comparison table</a> shows
          honestly where hang4r stands in the landscape.
        </p>
        <a href="https://hang4r.dev/" style="display:inline-block;background:#5b5bd6;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px;">hang4r.dev</a>
      </div>
      <p style="font-size:12px;color:#8a8aa3;line-height:1.6;margin:20px 8px 0;">
        You're receiving this because ${email} was submitted at hang4r.dev.
        Wasn't you, or changed your mind? <a href="${unsubUrl}" style="color:#8a8aa3;">Unsubscribe</a>.
        <br />© 2026 hang4r · built by Angel Malavar
      </p>
    </div>
  </body>
</html>`

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let email = ''
  try {
    const body = (await request.json()) as { email?: string }
    email = (body.email ?? '').trim().toLowerCase()
  } catch {
    return json(400, { error: 'send JSON like {"email": "you@example.com"}' })
  }
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json(400, { error: "that doesn't look like an email" })
  }

  // dedupe: an existing ACTIVE signup is a success, not a second email —
  // but someone who unsubscribed and signs up again is deliberately opting back in
  const existing = await env.WAITLIST.get(email)
  if (existing) {
    let wasUnsubscribed = false
    try {
      wasUnsubscribed = Boolean((JSON.parse(existing) as { unsubscribed?: boolean }).unsubscribed)
    } catch {
      /* treat unparseable as active */
    }
    if (!wasUnsubscribed) {
      return json(200, { ok: true, already: true })
    }
  }

  await env.WAITLIST.put(
    email,
    JSON.stringify({
      ts: new Date().toISOString(),
      ua: request.headers.get('User-Agent') ?? '',
      country: (request as { cf?: { country?: string } }).cf?.country ?? ''
    })
  )

  // mirror into the Resend audience — best-effort; KV already has the signup
  const contactRes = await fetch(`${RESEND}/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, unsubscribed: false })
  })
  if (!contactRes.ok && contactRes.status !== 409) {
    console.error('resend contact error', contactRes.status, await contactRes.text())
  }

  // signed per-recipient unsubscribe link + RFC 8058 one-click headers
  const token = await unsubToken(email, env.UNSUB_SECRET)
  const unsubUrl = `https://hang4r.dev/api/unsubscribe?e=${encodeURIComponent(email)}&t=${token}`

  // send the confirmation — a failure here shouldn't lose the signup
  const emailRes = await fetch(`${RESEND}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: CONFIRMATION_SUBJECT,
      html: confirmationHtml(email, unsubUrl),
      reply_to: 'hello@hang4r.dev',
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    })
  })
  if (!emailRes.ok) {
    console.error('resend email error', emailRes.status, await emailRes.text())
  }

  return json(200, { ok: true })
}
