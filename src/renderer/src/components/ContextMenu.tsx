import { useEffect, useRef, type JSX } from 'react'
import { useHang4r } from '../state/store'

/** Global right-click menu. Any component calls openContextMenu(x, y, items). */
export function ContextMenu(): JSX.Element | null {
  const menu = useHang4r((s) => s.contextMenu)
  const close = useHang4r((s) => s.closeContextMenu)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, close])

  if (!menu) return null
  // keep the menu on-screen
  const x = Math.min(menu.x, window.innerWidth - 220)
  const y = Math.min(menu.y, window.innerHeight - menu.items.length * 30 - 12)

  return (
    <div className="ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={'ctx-item' + (item.danger ? ' ctx-item-danger' : '')}
            onClick={() => {
              close()
              item.onClick?.()
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}
