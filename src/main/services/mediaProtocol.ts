import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import type { Session } from 'electron'
import { MEDIA_SCHEME, inlineMediaMime, isUncPath, mediaPathFromUrl } from '../../shared/mediaUrl'

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` → inclusive [start,end], or null if unsatisfiable. Only a single range is honoured. */
function parseRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  return start <= end && start < size ? [start, end] : null
}

/**
 * Serve local media for the MAIN window only. Registered on the default session;
 * the embedded browser and HTML-preview webviews run in their own `persist:`
 * partitions, which have no handler for this scheme, so remote pages cannot reach it.
 *
 * Scope is deliberately no wider than files:data-url (any absolute/~ path), but
 * limited to media extensions — checked on the requested path AND the realpath,
 * so a `x.png` symlink to a non-media file is refused.
 */
export function handleMediaProtocol(ses: Session): void {
  ses.protocol.handle(MEDIA_SCHEME, async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: NO_STORE })
    }
    const raw = mediaPathFromUrl(req.url)
    if (!raw) return new Response(null, { status: 400, headers: NO_STORE })
    const expanded =
      raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
    if (
      isUncPath(raw) ||
      isUncPath(expanded) ||
      !isAbsolute(expanded) ||
      expanded.includes('\0') ||
      !inlineMediaMime(expanded)
    ) {
      return new Response(null, { status: 403, headers: NO_STORE })
    }
    let file: string
    let size: number
    try {
      file = await realpath(expanded)
      if (isUncPath(file)) return new Response(null, { status: 403, headers: NO_STORE })
      const s = await stat(file)
      if (!s.isFile()) return new Response(null, { status: 404, headers: NO_STORE })
      size = s.size
    } catch {
      return new Response(null, { status: 404, headers: NO_STORE })
    }
    const mime = inlineMediaMime(file)
    if (!mime) return new Response(null, { status: 403, headers: NO_STORE })

    const headers: Record<string, string> = {
      ...NO_STORE,
      'content-type': mime,
      'accept-ranges': 'bytes',
      // an SVG opened as a document must not run script; <img> never does anyway
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    }
    const rangeHeader = req.headers.get('range')
    let status = 200
    let start = 0
    let end = size - 1
    if (rangeHeader) {
      const r = parseRange(rangeHeader, size)
      if (!r) {
        return new Response(null, {
          status: 416,
          headers: { ...NO_STORE, 'content-range': `bytes */${size}` }
        })
      }
      ;[start, end] = r
      status = 206
      headers['content-range'] = `bytes ${start}-${end}/${size}`
    }
    const length = size === 0 ? 0 : end - start + 1
    headers['content-length'] = String(length)
    if (req.method === 'HEAD' || length === 0) return new Response(null, { status, headers })
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
    return new Response(body, { status, headers })
  })
}
