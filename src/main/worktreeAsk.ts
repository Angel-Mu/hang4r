import { BrowserWindow } from 'electron'

/**
 * Asked when a prompt lands on a session whose worktree is gone (the user
 * cleaned it up — `wt remove`, a merge-cleanup skill, Drop worktree). Rebuilding
 * costs a full setup run, which is wasted when the question only needs what the
 * agent already has in the conversation.
 */
export type WorktreeChoice = 'answer' | 'rebuild' | 'cancel'

let pending: ((choice: WorktreeChoice) => void) | null = null

/** Resolves 'rebuild' when there's no window to ask in — the old behavior, so a
 *  headless path can never silently lose the user's prompt. */
export function askWorktreeChoice(sessionId: string, title: string): Promise<WorktreeChoice> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.webContents.isDestroyed()) return Promise.resolve('rebuild')
  pending?.('cancel')
  win.webContents.send('worktree:ask', { sessionId, title })
  return new Promise<WorktreeChoice>((resolve) => {
    pending = resolve
  })
}

export function resolveWorktreeChoice(choice: WorktreeChoice): void {
  const resolve = pending
  pending = null
  resolve?.(choice)
}
