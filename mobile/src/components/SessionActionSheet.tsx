import { useRef, type JSX } from 'react'
import type { SessionMeta } from '@shared/protocol'
import { Icon } from '@shared/icons'
import { isFinishedUnseen, useApp } from '../state/store'

/** Long-press on a session row: the desktop sidebar's row menu, phone-sized. */
export function SessionActionSheet({
  session,
  onClose
}: {
  session: SessionMeta
  onClose: () => void
}): JSX.Element {
  const pinnedHere = useApp((s) => s.pinned.includes(session.id))
  const pinnedOnDesktop = useApp((s) => !!s.desktopLayout?.pinnedSessions.includes(session.id))
  const unseen = useApp((s) => isFinishedUnseen(s, session.id))
  const togglePin = useApp((s) => s.togglePin)
  const markSeenEverywhere = useApp((s) => s.markSeenEverywhere)
  const markUnseen = useApp((s) => s.markUnseen)
  // the sheet opens under a finger still down; releasing it can click
  // whatever the sheet put there. A real tap starts a new pointer on the sheet.
  const armed = useRef(false)
  const arm = (): void => {
    armed.current = true
  }
  const ghost = (): boolean => !armed.current
  const act = (fn: () => void): void => {
    if (ghost()) return
    fn()
    onClose()
  }

  return (
    <>
      <div className="sheet-scrim" onPointerDown={arm} onClick={() => !ghost() && onClose()} />
      <div className="sheet session-actions-sheet" role="menu" onPointerDown={arm}>
        <div className="sheet-grab" />
        <p className="sheet-title">{session.title}</p>
        {pinnedOnDesktop && !pinnedHere ? (
          <p className="sheet-note">
            <Icon name="pin" size={14} /> Pinned on your computer
          </p>
        ) : (
          <button className="sheet-action" role="menuitem" onClick={() => act(() => togglePin(session.id))}>
            <Icon name="pin" size={17} />
            {pinnedHere ? 'Unpin' : 'Pin to top'}
          </button>
        )}
        {unseen ? (
          <button
            className="sheet-action"
            role="menuitem"
            onClick={() => act(() => markSeenEverywhere(session.id))}
          >
            <Icon name="check" size={17} />
            Mark as read
          </button>
        ) : (
          <button
            className="sheet-action"
            role="menuitem"
            onClick={() => act(() => void markUnseen(session.id))}
          >
            <Icon name="bell" size={17} />
            Mark as unread
          </button>
        )}
      </div>
    </>
  )
}
