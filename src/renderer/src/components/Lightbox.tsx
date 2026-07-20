import { useEffect, type JSX } from 'react'
import { useHang4r } from '../state/store'

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
