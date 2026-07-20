import { useEffect, useState, type JSX } from 'react'

/**
 * Cursor-style quit confirm (replaces the native macOS warning box, which
 * can't be styled): bold title, plain sentence, right-aligned Cancel (Esc) /
 * Quit (↩). Main sends quit:confirm when live work would be interrupted.
 */
export function QuitConfirm(): JSX.Element | null {
  const [info, setInfo] = useState<{ message: string; detail: string } | null>(null)

  useEffect(() => window.hang4r.onQuitConfirm(setInfo), [])

  const answer = (quit: boolean): void => {
    setInfo(null)
    void window.hang4r.answerQuitConfirm(quit)
  }

  useEffect(() => {
    if (!info) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answer(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        answer(true)
      }
    }
    // capture phase so Esc can't also close panels underneath
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info])

  if (!info) return null
  return (
    <div className="dialog-backdrop quit-backdrop">
      <div className="quit-dialog" role="alertdialog" aria-label="Quit hang4r?">
        <div className="quit-title">Quit hang4r?</div>
        <div className="quit-message">
          {info.message} {info.detail}
        </div>
        <div className="quit-actions">
          <button className="ghost-btn quit-cancel" onClick={() => answer(false)}>
            Cancel <span className="quit-key">Esc</span>
          </button>
          <button className="primary-btn quit-go" onClick={() => answer(true)}>
            Quit <span className="quit-key">↩</span>
          </button>
        </div>
      </div>
    </div>
  )
}
