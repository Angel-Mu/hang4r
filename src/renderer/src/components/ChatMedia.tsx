import { memo, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import { useHang4r } from '../state/store'
import { isUncPath, mediaUrl } from '../../../shared/mediaUrl'
import {
  SAFE_IMAGE_TYPES,
  isImagePath,
  isVideoPath,
  proseMediaPaths,
  toolImages,
  type ToolImage
} from '../mediaUtil'
import { Icon } from './Icon'

const PROSE_MEDIA_MAX = 6

/**
 * Media the agent produced, shown in the conversation: screenshots returned by
 * tool results, files named in prose / markdown images / Write rows, and video.
 * Everything heavy is gated on visibility — a long session holds hundreds of
 * these and none may be fetched or decoded until scrolled near.
 */

/** one-shot: flips true the first time the element nears the viewport */
function useSeen(): [RefObject<HTMLSpanElement | null>, boolean] {
  const ref = useRef<HTMLSpanElement>(null)
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (seen || !el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin: '300px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

/**
 * Existence checks and (remote-only) data-URL reads are cached per (session,
 * path): a settled message remounts as the list scrolls through
 * content-visibility, and a missing file must not be asked for again on every
 * remount. Misses expire so a file written later can appear.
 */
/** exists: null = unknowable (e.g. an SSH path outside the remote workdir) */
type Resolved = { exists: boolean | null; abs?: string }
const resolveCache = new Map<string, Promise<Resolved>>()
const RESOLVE_CACHE_MAX = 500
const MISS_TTL_MS = 30_000

function resolveMedia(sessionId: string, path: string): Promise<Resolved> {
  const key = `${sessionId}\0${path}`
  const hit = resolveCache.get(key)
  if (hit) return hit
  const p: Promise<Resolved> = window.hang4r
    .fileExists(sessionId, path)
    .catch(() => ({ exists: false }))
  resolveCache.set(key, p)
  void p.then((r) => {
    if (r.exists !== true) setTimeout(() => resolveCache.delete(key), MISS_TTL_MS)
  })
  if (resolveCache.size > RESOLVE_CACHE_MAX)
    resolveCache.delete(resolveCache.keys().next().value as string)
  return p
}

const openImage = (src: string, alt: string): void =>
  useHang4r.getState().openLightbox(src, 'image', alt)

function MissingChip({ path }: { path: string }): JSX.Element {
  return (
    <span
      className="chat-media-chip chat-media-missing"
      title={`${path}\nMissing, unreadable, or over 12 MB`}
    >
      file no longer exists · {path}
    </span>
  )
}

function Skeleton({ innerRef }: { innerRef: RefObject<HTMLSpanElement | null> }): JSX.Element {
  return <span className="chat-media-ph" ref={innerRef} />
}

/** An inline base64 image from a tool result. The data URL is built only once visible. */
function InlineImage({ img, alt }: { img: ToolImage; alt: string }): JSX.Element {
  const [ref, seen] = useSeen()
  const [broken, setBroken] = useState(false)
  const src = useMemo(
    () => (seen ? `data:${img.mediaType};base64,${img.data}` : ''),
    [seen, img.mediaType, img.data]
  )
  if (broken)
    return <span className="chat-media-chip chat-media-missing">image can’t be displayed</span>
  if (!seen) return <Skeleton innerRef={ref} />
  return (
    <img
      className="chat-media-img"
      src={src}
      alt={alt}
      decoding="async"
      onError={() => setBroken(true)}
      onClick={() => openImage(src, alt)}
    />
  )
}

type FileState = { src: string | null } | 'missing' | 'unknown' | null

/**
 * Local files stream over hang4r-media:// (no 12 MB data-URL ceiling, video
 * seeks); an SSH session has no local abs path, so images fall back to a data
 * URL and video to an open chip.
 */
export const FileMedia = memo(function FileMedia({
  sessionId,
  path,
  quiet
}: {
  sessionId: string
  path: string
  /** render nothing instead of a "no longer exists" chip when the file is absent */
  quiet?: boolean
}): JSX.Element | null {
  const [ref, seen] = useSeen()
  const [state, setState] = useState<FileState>(null)
  // bumped once when a miss's cache entry expires, so a mounted chip re-checks
  const [attempt, setAttempt] = useState(0)
  const blocked = isUncPath(path)
  const video = isVideoPath(path)
  useEffect(() => {
    if (!seen || blocked) return
    let live = true
    void (async () => {
      const r = await resolveMedia(sessionId, path)
      if (!live) return
      if (r.exists === null) return setState('unknown')
      if (!r.exists) return setState('missing')
      if (r.abs) return setState({ src: mediaUrl(r.abs) })
      if (video) return setState({ src: null })
      const url = await window.hang4r.readFileDataUrl(sessionId, path).catch(() => null)
      if (live) setState(url ? { src: url } : 'missing')
    })()
    return () => {
      live = false
    }
  }, [seen, blocked, sessionId, path, video, attempt])

  useEffect(() => {
    if (state !== 'missing' || attempt > 0) return
    const t = setTimeout(() => setAttempt(1), MISS_TTL_MS + 100)
    return () => clearTimeout(t)
  }, [state, attempt])

  const name = path.split('/').pop() ?? path
  if (blocked) return quiet ? null : <MissingChip path={path} />
  if (state === null) return <Skeleton innerRef={ref} />
  if (state === 'unknown') return null
  if (state === 'missing') return quiet ? null : <MissingChip path={path} />
  const { src } = state
  if (!src) {
    return (
      <button
        className="chat-media-chip"
        title={`Open ${path}`}
        onClick={() => useHang4r.getState().requestOpenFile(sessionId, path)}
      >
        video · {name}
      </button>
    )
  }
  if (!video) {
    return (
      <img
        className="chat-media-img"
        src={src}
        alt={name}
        title={path}
        decoding="async"
        onError={() => setState('missing')}
        onClick={() => openImage(src, name)}
      />
    )
  }
  return (
    <span className="chat-media-video">
      <video
        src={src}
        controls
        preload="metadata"
        title={path}
        onError={() => setState('missing')}
      />
      <button
        className="chat-media-expand"
        title="Enlarge"
        onClick={() => useHang4r.getState().openLightbox(src, 'video', name)}
      >
        <Icon name="maximize" size={13} />
      </button>
    </span>
  )
})

type MediaEntry = { key: string; image?: ToolImage; path?: string }

/** media a tool row carries: screenshots in its result, or an image it Wrote */
function toolEntries(item: {
  key?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: unknown
}): MediaEntry[] {
  const out: MediaEntry[] = toolImages(item.toolResult).map((image, i) => ({
    key: `r${i}`,
    image
  }))
  if (item.toolName === 'Write' && item.toolInput && typeof item.toolInput === 'object') {
    const p = (item.toolInput as Record<string, unknown>).file_path
    if (typeof p === 'string' && isImagePath(p)) out.push({ key: `w:${p}`, path: p })
  }
  return out
}

function MediaEntries({
  entries,
  sessionId,
  limit
}: {
  entries: MediaEntry[]
  sessionId: string
  limit?: number
}): JSX.Element | null {
  if (entries.length === 0) return null
  const shown = limit ? entries.slice(0, limit) : entries
  return (
    <span className="chat-media">
      {shown.map((e, i) =>
        e.image ? (
          <InlineImage key={e.key + i} img={e.image} alt="tool result image" />
        ) : (
          <FileMedia key={e.key} sessionId={sessionId} path={e.path as string} />
        )
      )}
      {limit && entries.length > limit && (
        <span className="chat-media-more">+{entries.length - limit} more</span>
      )}
    </span>
  )
}

/** thumbnails directly under a tool row, no expanding needed */
export function ToolMedia({
  item,
  sessionId
}: {
  item: { toolName?: string; toolInput?: unknown; toolResult?: unknown }
  sessionId: string
}): JSX.Element | null {
  const entries = useMemo(() => toolEntries(item), [item.toolName, item.toolInput, item.toolResult]) // eslint-disable-line react-hooks/exhaustive-deps
  return <MediaEntries entries={entries} sessionId={sessionId} />
}

/** a collapsed activity group would otherwise hide every screenshot inside it */
export function GroupMedia({
  items,
  sessionId
}: {
  items: { key: string; toolName?: string; toolInput?: unknown; toolResult?: unknown }[]
  sessionId: string
}): JSX.Element | null {
  const entries = useMemo(
    () => items.flatMap((it) => toolEntries(it).map((e) => ({ ...e, key: `${it.key}:${e.key}` }))),
    [items]
  )
  return <MediaEntries entries={entries} sessionId={sessionId} limit={4} />
}

/** inline thumbnails/players for the media an assistant message mentions by path */
export const ProseMedia = memo(function ProseMedia({
  text,
  sessionId
}: {
  text: string
  sessionId: string
}): JSX.Element | null {
  const paths = useMemo(() => proseMediaPaths(text), [text])
  if (paths.length === 0) return null
  const shown = paths.slice(0, PROSE_MEDIA_MAX)
  return (
    <span className="chat-media chat-media-prose">
      {shown.map((p) => (
        // always quiet: "I'll save it to out/shot.png" is a mention, not a
        // deliverable, so a missing prose path must never raise the chip
        <FileMedia key={p} sessionId={sessionId} path={p} quiet />
      ))}
      {paths.length > shown.length && (
        <span className="chat-media-more">+{paths.length - shown.length} more</span>
      )}
    </span>
  )
})

/** the markdown `![alt](src)` renderer */
export function MdImage({
  sessionId,
  src,
  alt
}: {
  sessionId: string
  src?: string
  alt?: string
}): JSX.Element {
  const label = alt || 'image'
  if (!src) return <span className="chat-media-chip">{label}</span>
  if (/^data:/i.test(src)) {
    const type = /^data:(image\/[a-z]+);base64,/i.exec(src)?.[1]?.toLowerCase()
    if (!type || !SAFE_IMAGE_TYPES.has(type))
      return <span className="chat-media-chip">{label}</span>
    return (
      <img className="chat-media-img" src={src} alt={label} onClick={() => openImage(src, label)} />
    )
  }
  // Remote images are never fetched: a model-written URL is a tracking pixel.
  if (/^https?:\/\//i.test(src)) {
    return (
      <span className="chat-media-chip" title={src}>
        {label} ·{' '}
        <a
          href={src}
          onClick={(e) => {
            e.preventDefault()
            useHang4r.getState().requestOpenUrl(sessionId, src)
          }}
        >
          open link
        </a>
      </span>
    )
  }
  let path = src.trim().replace(/^file:\/\//i, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    /* keep the raw path */
  }
  // never hand a network path to the file layer (see isUncPath); a
  // file://host/x URL is the same thing with the leading slash dropped
  if (isUncPath(path) || (/^file:/i.test(src.trim()) && !/^(\/|[a-z]:)/i.test(path))) {
    return <span className="chat-media-chip">{label}</span>
  }
  if (!isImagePath(path) && !isVideoPath(path))
    return <span className="chat-media-chip">{label}</span>
  return (
    <span className="chat-media chat-media-inline">
      <FileMedia sessionId={sessionId} path={path} />
    </span>
  )
}
