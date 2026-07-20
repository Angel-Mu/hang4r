import { useEffect, useState, type JSX } from 'react'
import { useHang4r } from '../state/store'

/** Promise-based prompt/confirm modal (Electron lacks window.prompt/confirm). */
export function InputDialog(): JSX.Element | null {
  const dialog = useHang4r((s) => s.dialog)
  const resolve = useHang4r((s) => s.resolveDialog)
  const [value, setValue] = useState('')

  useEffect(() => {
    if (dialog?.kind === 'prompt') setValue(dialog.initial)
  }, [dialog])

  if (!dialog) return null

  if (dialog.kind === 'save') {
    return (
      <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && resolve('cancel' as never)}>
        <div className="dialog input-dialog">
          <div className="dialog-title input-dialog-title">{dialog.title}</div>
          <div className="settings-note">{dialog.detail}</div>
          <div className="dialog-actions">
            <button className="ghost-btn" onClick={() => resolve('cancel' as never)}>
              Cancel
            </button>
            <button className="ghost-btn" onClick={() => resolve('dont' as never)}>
              Don’t Save
            </button>
            <button className="primary-btn" onClick={() => resolve('save' as never)}>
              Save
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && resolve(null)}>
      <div className="dialog input-dialog">
        <div className="dialog-title input-dialog-title">{dialog.title}</div>
        {dialog.kind === 'prompt' && (
          <input
            className="field"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') resolve(value)
              if (e.key === 'Escape') resolve(null)
            }}
          />
        )}
        <div className="dialog-actions">
          <button className="ghost-btn" onClick={() => resolve(dialog.kind === 'confirm' ? false : null)}>
            Cancel
          </button>
          <button
            className="primary-btn"
            onClick={() => resolve(dialog.kind === 'prompt' ? value : true)}
          >
            {dialog.kind === 'confirm' ? 'Confirm' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
