#!/usr/bin/env node
/**
 * Send the release-announcement email to everyone on the hang4r waitlist.
 *
 * The waitlist lives in the Cloudflare KV namespace bound as WAITLIST (see
 * wrangler.toml) because the Resend key is send-only. This script lists the
 * emails via `wrangler kv` and sends one email per subscriber via Resend.
 *
 * Usage (from landing/):
 *   node scripts/send-release.mjs --version 0.1.0 \
 *     --download-url https://github.com/Angel-Mu/hang4r/releases/download/v0.1.0/hang4r-0.1.0.dmg \
 *     [--notes-url https://github.com/Angel-Mu/hang4r/releases/tag/v0.1.0] \
 *     [--dry-run]
 *
 * Reads RESEND_API_KEY from the environment or ../.env. --dry-run prints the
 * recipient list and one rendered email without sending anything.
 */
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RESEND = 'https://api.resend.com'
const KV_NAMESPACE_ID = 'd8f312dfb10b41cd82aee632beae8816' // hang4r-waitlist

// --- tiny arg parser ---
const args = process.argv.slice(2)
const getArg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const version = getArg('--version')
const downloadUrl = getArg('--download-url')
const notesUrl = getArg('--notes-url') ?? 'https://github.com/Angel-Mu/hang4r/releases'
const dryRun = args.includes('--dry-run')

if (!version || !downloadUrl) {
  console.error('usage: send-release.mjs --version X.Y.Z --download-url <url> [--notes-url <url>] [--dry-run]')
  process.exit(1)
}

// --- env: process env first, then ../.env and ../../.env ---
for (const envPath of [join(here, '..', '.env'), join(here, '..', '..', '.env')]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  }
}
const { RESEND_API_KEY, UNSUB_SECRET } = process.env
if (!RESEND_API_KEY || !UNSUB_SECRET) {
  console.error('missing RESEND_API_KEY / UNSUB_SECRET (env or .env)')
  process.exit(1)
}

const unsubUrl = (email) => {
  const token = createHmac('sha256', UNSUB_SECRET).update(email).digest('hex').slice(0, 32)
  return `https://hang4r.dev/api/unsubscribe?e=${encodeURIComponent(email)}&t=${token}`
}

// --- recipients from KV (skipping anyone who unsubscribed) ---
const kvOut = execFileSync(
  'npx',
  ['wrangler', 'kv', 'key', 'list', `--namespace-id=${KV_NAMESPACE_ID}`, '--remote'],
  { cwd: join(here, '..'), encoding: 'utf8' }
)
const allKeys = JSON.parse(kvOut).map((k) => k.name)
const emails = []
for (const key of allKeys) {
  try {
    const raw = execFileSync(
      'npx',
      ['wrangler', 'kv', 'key', 'get', key, `--namespace-id=${KV_NAMESPACE_ID}`, '--remote'],
      { cwd: join(here, '..'), encoding: 'utf8' }
    )
    if (JSON.parse(raw).unsubscribed) {
      console.log(`  skipping (unsubscribed): ${key}`)
      continue
    }
  } catch {
    /* unparseable value → treat as active */
  }
  emails.push(key)
}
console.log(`${emails.length} active subscriber(s) on the waitlist (${allKeys.length - emails.length} unsubscribed)`)
if (emails.length === 0) process.exit(0)

const html = readFileSync(join(here, '..', 'emails', 'release-announcement.html'), 'utf8')
  .replace(/\{\{VERSION\}\}/g, version)
  .replace(/\{\{DOWNLOAD_URL\}\}/g, downloadUrl)
  .replace(/\{\{RELEASE_NOTES_URL\}\}/g, notesUrl)

if (dryRun) {
  console.log('dry run — recipients:', emails.join(', '))
  console.log('--- rendered subject ---')
  console.log(`hang4r v${version} is out — your agents, in parallel`)
  process.exit(0)
}

const headers = { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }
let sent = 0
let failed = 0
for (const to of emails) {
  const unsub = unsubUrl(to)
  const res = await fetch(`${RESEND}/emails`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: 'hang4r <hello@hang4r.dev>',
      reply_to: 'hello@hang4r.dev',
      to: [to],
      subject: `hang4r v${version} is out — your agents, in parallel`,
      html: html.replace(/\{\{UNSUBSCRIBE_URL\}\}/g, unsub),
      headers: {
        'List-Unsubscribe': `<${unsub}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    })
  })
  if (res.ok) {
    sent++
  } else {
    failed++
    console.error(`  ✗ ${to}: ${res.status} ${await res.text()}`)
  }
  // Resend rate limit is 2 req/s on most plans — pace ourselves
  await new Promise((r) => setTimeout(r, 600))
}
console.log(`done: ${sent} sent, ${failed} failed`)
