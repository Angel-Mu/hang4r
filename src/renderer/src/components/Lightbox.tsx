import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useHang4r } from '../state/store'
import { mdComponents, MdCode } from './MarkdownBlocks'

/**
 * A zoomable/pannable viewer for an enlarged mermaid diagram. Opens FIT to the
 * viewport (the whole diagram visible — Angel: enlarged was "too big" with no
 * zoom), then scroll-wheel or the +/−/Fit controls zoom, and drag pans. The SVG
 * is vector so it stays crisp at any scale.
 */
function DiagramViewer({ svg }: { svg: string }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const fit = useCallback(() => {
    const vp = viewportRef.current
    const el = vp?.querySelector('svg') as SVGSVGElement | null
    if (!vp || !el) return
    const vb = el.viewBox?.baseVal
    const w = (vb && vb.width) || el.getBoundingClientRect().width || 800
    const h = (vb && vb.height) || el.getBoundingClientRect().height || 600
    // normalize to natural pixel size so scale() is predictable (mermaid emits
    // width="100%" + an inline max-width, which would fight the transform)
    el.style.width = `${w}px`
    el.style.height = `${h}px`
    el.style.maxWidth = 'none'
    const s = Math.min(vp.clientWidth / w, vp.clientHeight / h) * 0.92
    setScale(Math.min(2, s > 0 ? s : 1)) // don't blow a tiny diagram up absurdly
    setPos({ x: 0, y: 0 })
  }, [])

  useLayoutEffect(() => {
    fit()
  }, [fit, svg])

  const zoom = (factor: number): void => setScale((s) => Math.min(8, Math.max(0.1, s * factor)))

  return (
    <div className="lightbox-diagram" onClick={(e) => e.stopPropagation()}>
      <div
        ref={viewportRef}
        className="diagram-viewport"
        onWheel={(e) => {
          e.preventDefault()
          zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)
        }}
        onPointerDown={(e) => {
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) setPos({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) })
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <div
          className="diagram-canvas"
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="diagram-controls" onClick={(e) => e.stopPropagation()}>
        <button title="Zoom out" onClick={() => zoom(1 / 1.2)}>
          −
        </button>
        <span className="diagram-zoom">{Math.round(scale * 100)}%</span>
        <button title="Zoom in" onClick={() => zoom(1.2)}>
          +
        </button>
        <button className="diagram-fit" title="Fit to view" onClick={fit}>
          Fit
        </button>
      </div>
    </div>
  )
}

/**
 * Full-screen click-to-enlarge overlay for a rendered attachment. The chat
 * thumbnails advertise a zoom-in cursor but had no click target (Angel: the
 * magnifier "+" did nothing) — now clicking one opens it here at viewport size.
 * Backdrop click or Esc closes. Images render as-is; PDFs use an <embed> so the
 * same affordance works for "things that can be rendered" as the user expected.
 */
export function Lightbox(): JSX.Element | null {
  const box = useHang4r((s) => s.lightbox)
  const close = useHang4r((s) => s.closeLightbox)

  useEffect(() => {
    if (!box) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    // capture so Esc closes the lightbox before any pane-level Esc handler
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [box, close])

  if (!box) return null

  return (
    <div className="lightbox-backdrop" onClick={close}>
      <button className="lightbox-close" title="Close (Esc)" onClick={close}>
        ×
      </button>
      {box.kind === 'pdf' ? (
        <embed
          className="lightbox-pdf"
          src={box.src}
          type="application/pdf"
          onClick={(e) => e.stopPropagation()}
        />
      ) : box.kind === 'diagram' ? (
        <DiagramViewer svg={box.svg ?? ''} />
      ) : box.kind === 'markdown' || box.kind === 'text' ? (
        // text/markdown attachment → readable document, NOT raw bytes
        <div className="lightbox-doc" onClick={(e) => e.stopPropagation()}>
          {box.alt ? <div className="lightbox-doc-title">{box.alt}</div> : null}
          {box.kind === 'markdown' ? (
            // shared components so a ```mermaid fence renders a diagram (not raw
            // code) and links open in-app — the bare renderer had neither (Angel)
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={box.sessionId ? mdComponents(box.sessionId, box.path) : { code: MdCode }}
              >
                {box.text ?? ''}
              </ReactMarkdown>
            </div>
          ) : (
            <pre className="lightbox-doc-pre">{box.text}</pre>
          )}
        </div>
      ) : (
        <img
          className="lightbox-img"
          src={box.src}
          alt={box.alt ?? 'attachment'}
          // clicks on the media itself must not close (only the backdrop does)
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  )
}
