import { useEffect, useState, type JSX } from 'react'
import { Icon } from '@shared/icons'
import { bridge, useApp } from '../state/store'

/** Left navigation drawer, opened from the title. Holds everything that used
 *  to crowd the top bar — the bar keeps only the one primary action (+). */
export function Drawer({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const setScreen = useApp((s) => s.setScreen)
  const refresh = useApp((s) => s.refresh)
  const refreshing = useApp((s) => s.refreshing)
  const conn = useApp((s) => s.conn)
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    bridge()
      .call<string>('appVersion')
      .then(setDesktopVersion)
      .catch(() => setDesktopVersion(null))
  }, [open])

  const go = (screen: 'new' | 'usage' | 'settings'): void => {
    onClose()
    setScreen(screen)
  }

  return (
    <>
      <div className={'drawer-scrim' + (open ? ' drawer-scrim-open' : '')} onClick={onClose} />
      <nav className={'drawer' + (open ? ' drawer-open' : '')} aria-hidden={!open}>
        <div className="drawer-brand">
          <span className="brand-mark">▐</span>
          <span className="brand-name">hang4r</span>
        </div>
        <button className="drawer-item" onClick={() => go('new')}>
          <span className="drawer-item-icon">＋</span> New agent
        </button>
        <button className="drawer-item" onClick={() => go('usage')}>
          <Icon name="gauge" size={18} /> Usage
        </button>
        <button className="drawer-item" aria-label="Settings" onClick={() => go('settings')}>
          <Icon name="gear" size={18} /> Settings
        </button>
        <button
          className="drawer-item"
          disabled={refreshing || conn !== 'online'}
          onClick={() => {
            void refresh()
            onClose()
          }}
        >
          <Icon name="refresh" size={18} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <div className="drawer-footer">
          <span>hang4r mobile 0.1.0</span>
          {desktopVersion && <span>desktop {desktopVersion}</span>}
        </div>
      </nav>
    </>
  )
}
