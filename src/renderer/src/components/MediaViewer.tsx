import { useEffect, useState, type JSX } from 'react'
import { htmlDataUrl } from '../htmlPreview'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { mdComponents } from './MarkdownBlocks'

export type MediaKind = 'image' | 'pdf' | 'markdown' | 'html' | 'code'

export function mediaKind(path: string): MediaKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  return 'code'
}

/**
 * Renders non-code files inline in an editor tab: images, PDFs, a Markdown
 * preview, and a sandboxed HTML preview (Cursor/VS Code parity).
 */
export function MediaViewer({
  sessionId,
  path,
  kind
}: {
  sessionId: string
  path: string
  kind: MediaKind
}): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [text, setText] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (kind === 'image' || kind === 'pdf') {
      void window.hang4r.readFileDataUrl(sessionId, path).then((d) => {
        if (!cancelled) d ? setDataUrl(d) : setErr('Cannot preview this file (too large or unsupported).')
      })
    } else {
      void window.hang4r.readFile(sessionId, path).then((r) => !cancelled && setText(r.content))
    }
    return () => {
      cancelled = true
    }
  }, [sessionId, path, kind])

  if (err) return <div className="media-empty">{err}</div>

  if (kind === 'image') {
    return (
      <div className="media-viewer media-image">
        {dataUrl ? <img src={dataUrl} alt={path} /> : <div className="media-empty">Loading…</div>}
      </div>
    )
  }
  if (kind === 'pdf') {
    return (
      <div className="media-viewer media-pdf">
        {dataUrl ? (
          <embed src={dataUrl} type="application/pdf" width="100%" height="100%" />
        ) : (
          <div className="media-empty">Loading…</div>
        )}
      </div>
    )
  }
  if (kind === 'markdown') {
    return (
      <div className="media-viewer media-markdown">
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(sessionId, path)}>{text}</ReactMarkdown>
        </div>
      </div>
    )
  }
  // html — sandboxed preview (no scripts, no same-origin)
  return (
    <div className="media-viewer media-html">
      <webview src={htmlDataUrl(text)} partition="persist:hang4r-preview" className="html-preview-webview" />
    </div>
  )
}
