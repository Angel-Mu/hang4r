/**
 * Inline chat media (images + video) is served by the main process over the
 * `hang4r-media://` scheme (see mediaProtocol.ts) so video can stream with Range
 * requests instead of a 12 MB data: URL. The whole absolute path rides in ONE
 * encoded path segment, so spaces, unicode, `#` and `?` can't be re-parsed as
 * URL structure.
 */
export const MEDIA_SCHEME = 'hang4r-media'

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'] as const
export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'ogg', 'ogv'] as const

const MEDIA_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogg: 'video/ogg',
  ogv: 'video/ogg'
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i + 1).toLowerCase()
}

/** 'image' | 'video' for an inline-renderable media path, else null */
export function inlineMediaKind(path: string): 'image' | 'video' | null {
  const ext = extOf(path)
  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return 'image'
  if ((VIDEO_EXTS as readonly string[]).includes(ext)) return 'video'
  return null
}

/** Content-Type for an inline-renderable media path, else null */
export function inlineMediaMime(path: string): string | null {
  return MEDIA_MIME[extOf(path)] ?? null
}

/** URL for an ABSOLUTE local path (resolve `~`/relative paths first — files:exists returns `abs`). */
export function mediaUrl(absPath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(absPath)}`
}

/** Inverse of mediaUrl for the protocol handler; null when the URL isn't one of ours. */
export function mediaPathFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${MEDIA_SCHEME}:` || u.hostname !== 'local') return null
    return decodeURIComponent(u.pathname.slice(1))
  } catch {
    return null
  }
}

/**
 * A UNC / network-share path (`\\host\x`, `//host/x`, mixed `/\`). On Windows an
 * fs call on one opens an SMB connection and leaks the user's NTLM hash to
 * whatever host an agent- or markdown-supplied path names, so it must be refused
 * BEFORE any fs access (raw and resolved form alike).
 */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}
