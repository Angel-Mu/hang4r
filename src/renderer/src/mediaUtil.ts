import { IMAGE_EXTS, VIDEO_EXTS, inlineMediaKind } from '../../shared/mediaUrl'
import { defaultUrlTransform } from 'react-markdown'

/** Pure helpers for agent-produced media (kept apart from the components for fast refresh). */

export const isImagePath = (p: string): boolean => inlineMediaKind(p) === 'image'
export const isVideoPath = (p: string): boolean => inlineMediaKind(p) === 'video'

/** tool-result media_type goes into a data: URL — only these may. */
export const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type ToolImage = { mediaType: string; data: string; bytes: number }

function imageBlock(b: unknown): { media_type?: unknown; data: string } | null {
  if (!b || typeof b !== 'object') return null
  const blk = b as {
    type?: unknown
    source?: { type?: unknown; media_type?: unknown; data?: unknown }
  }
  if (blk.type !== 'image' || !blk.source || typeof blk.source.data !== 'string') return null
  return { media_type: blk.source.media_type, data: blk.source.data }
}

const byteLen = (b64: string): number => Math.floor((b64.length * 3) / 4)

function fmtBytes(n: number): string {
  const kb = Math.max(1, Math.round(n / 1024))
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
}

/** the renderable base64 image blocks of a tool result (text blocks ignored) */
export function toolImages(result: unknown): ToolImage[] {
  if (!Array.isArray(result)) return []
  const out: ToolImage[] = []
  for (const b of result) {
    const img = imageBlock(b)
    const mt = typeof img?.media_type === 'string' ? img.media_type.toLowerCase() : ''
    if (img && SAFE_IMAGE_TYPES.has(mt))
      out.push({ mediaType: mt, data: img.data, bytes: byteLen(img.data) })
  }
  return out
}

/** the result with each base64 payload swapped for `[image 155 KB]`, for the JSON view */
export function redactImages(result: unknown): unknown {
  if (!Array.isArray(result)) return result
  let hit = false
  const out = result.map((b) => {
    const img = imageBlock(b)
    if (!img) return b
    hit = true
    const blk = b as { source: Record<string, unknown> }
    return { ...blk, source: { ...blk.source, data: `[image ${fmtBytes(byteLen(img.data))}]` } }
  })
  return hit ? out : result
}

// An image/video file path in prose, or inline code. The lookbehind rejects
// URLs (…//host/a.png) and mid-token starts; the lookahead rejects `a.pngx`.
const PROSE_MEDIA_RE = new RegExp(
  String.raw`(?<![\w/\\:.~@-])(?:~\/|\.{0,2}\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\.(?:${[...IMAGE_EXTS, ...VIDEO_EXTS.filter((e) => e !== 'ogg')].join('|')})(?![\w/])`,
  'gi'
)

/** media paths an assistant message names, outside code fences and ![](…) syntax */
export function proseMediaPaths(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  return [...new Set(prose.match(PROSE_MEDIA_RE) ?? [])]
}

/**
 * react-markdown's default URL sanitizer blanks `data:` and `file:` image
 * sources. Allow those for `src` only (MdImage vets them); links are untouched.
 */
export function mdUrlTransform(url: string, key: string): string {
  if (key === 'src' && /^(data:image\/|file:\/\/)/i.test(url)) return url
  return defaultUrlTransform(url)
}
