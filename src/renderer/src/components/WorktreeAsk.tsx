import { useEffect, useState, type JSX } from 'react'

/**
 * A prompt landed on a session whose worktree was cleaned up. Rebuilding it
 * re-runs the whole setup script, which is wasted when the question only needs
 * what the agent already has in the conversation — so the choice is the user's.
 * Answered once per session; "Recreate worktree" in the session menu undoes it.
 */
export function WorktreeAsk(): JSX.Element | null {
  const [info, setInfo] = useState<{ sessionId: string; title: string } | null>(null)

  useEffect(() => window.hang4r.onWorktreeAsk(setInfo), [])

  const answer = (choice: 'answer' | 'rebuild' | 'cancel'): void => {
    setInfo(null)
    void window.hang4r.answerWorktreeAsk(choice)
  }

  useEffect(() => {
    if (!info) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answer('cancel')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        answer('answer')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info])

  if (!info) return null
  return (
    <div className="dialog-backdrop quit-backdrop">
      <div className="quit-dialog wt-dialog" role="alertdialog" aria-label="Worktree removed">
        <div className="quit-title">The worktree for “{info.title}” is gone</div>
        <div className="quit-message">
          You cleaned it up. Rebuilding it re-runs this workspace’s setup script — worth it to keep
          working on the code, wasted if you just want an answer from what’s already in this
          conversation.
        </div>
        <div className="quit-actions wt-actions">
          <button className="ghost-btn quit-cancel" onClick={() => answer('cancel')}>
            Cancel <span className="quit-key">Esc</span>
          </button>
          <button className="ghost-btn wt-rebuild" onClick={() => answer('rebuild')}>
            Rebuild worktree
          </button>
          <button className="primary-btn quit-go" onClick={() => answer('answer')}>
            Answer from the conversation <span className="quit-key">↩</span>
          </button>
        </div>
      </div>
    </div>
  )
}
