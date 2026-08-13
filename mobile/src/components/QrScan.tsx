import { useEffect, useRef, useState, type JSX } from 'react'
import jsQR from 'jsqr'

/**
 * In-webview QR scanner: getUserMedia + jsQR, no native plugin. WKWebView
 * supports camera capture from iOS 14.3+; the simulator has no camera and
 * fails into `error`, where the paste flow remains the fallback.
 */
export function QrScan({
  onResult,
  onClose
}: {
  onResult: (raw: string) => void
  onClose: () => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const tick = (): void => {
      if (stopped) return
      const video = videoRef.current
      if (video && video.readyState >= 2 && ctx) {
        // decode at capped resolution — full 4K frames make jsQR crawl
        const scale = Math.min(1, 640 / video.videoWidth)
        canvas.width = video.videoWidth * scale
        canvas.height = video.videoHeight * scale
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(img.data, img.width, img.height)
        if (code?.data) {
          stopped = true
          onResult(code.data)
          return
        }
      }
      raf = requestAnimationFrame(tick)
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        const video = videoRef.current
        if (video) {
          video.srcObject = s
          void video.play()
        }
        raf = requestAnimationFrame(tick)
      })
      .catch((err) =>
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera access was denied — paste the pairing link instead.'
            : 'No camera available — paste the pairing link instead.'
        )
      )

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [onResult])

  return (
    <div className="qr-overlay">
      {error ? (
        <p className="pair-error qr-error">{error}</p>
      ) : (
        <>
          <video ref={videoRef} className="qr-video" playsInline muted />
          <div className="qr-frame" />
          <p className="qr-hint">Point at the QR code in hang4r → Settings → Phone</p>
        </>
      )}
      <button className="btn qr-close" onClick={onClose}>
        Cancel
      </button>
    </div>
  )
}
