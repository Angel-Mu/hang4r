import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useHang4r } from '../state/store'
import { mdComponents, MdCode } from './MarkdownBlocks'

/** aspect ratio (w/h) of a mermaid SVG from its viewBox — reliable as a RATIO
 *  even though its absolute pixel size isn't (mermaid emits width="100%"). */
function svgAspect(el: SVGSVGElement): number {
  const attr = el.getAttribute('viewBox')
  if (attr) {
    const p = attr.split(/[\s,]+/).map(Number)
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return p[2] / p[3]
  }
  const vb = el.viewBox?.baseVal
  if (vb && vb.width > 0 && vb.height > 0) return vb.width / vb.height
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? r.width / r.height : 1.6
}

/**
 * A zoomable/pannable viewer for an enlarged mermaid diagram. Opens FIT to the
 * viewport (the whole diagram visible — Angel: enlarged was "too big"/tiny with
 * broken zoom), then scroll-wheel or +/−/Fit controls zoom, and drag pans. We
 * control the diagram's RENDER WIDTH directly (the SVG fills it at width:100%,
 * height auto via its viewBox) rather than transform-scaling an unreliably-sized
 * SVG — so "fit" genuinely fills the modal and 100% = fits-the-view. Vector stays
 * crisp at any width.
 */
function DiagramViewer({ svg }: { svg: string }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0) // px render width of the diagram
  const [fitW, setFitW] = useState(0) // the fit width (= 100% zoom reference)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const fit = useCallback(() => {
    const vp = viewportRef.current
    const el = vp?.querySelector('svg') as SVGSVGElement | null
    if (!vp || !el) return
    const aspect = svgAspect(el)
    // widest the diagram can be while BOTH it and its (width/aspect) height fit
    const w = Math.min(vp.clientWidth, vp.clientHeight * aspect) * 0.94
    setFitW(w)
    setWidth(w)
    setPos({ x: 0, y: 0 })
  }, [])

  useLayoutEffect(() => {
    fit()
  }, [fit, svg])

  const zoom = (factor: number): void =>
    setWidth((w) => Math.max(80, Math.min((fitW || 1) * 12, w * factor)))
  const pct = fitW ? Math.round((width / fitW) * 100) : 100

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
          style={{ width: `${width}px`, transform: `translate(${pos.x}px, ${pos.y}px)` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="diagram-controls" onClick={(e) => e.stopPropagation()}>
        <button title="Zoom out" onClick={() => zoom(1 / 1.2)}>
          −
        </button>
        <span className="diagram-zoom">{pct}%</span>
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
