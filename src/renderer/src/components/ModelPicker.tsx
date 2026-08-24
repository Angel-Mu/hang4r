import { useEffect, useRef, useState, type JSX } from 'react'
import type { ModelChoice } from '../../../shared/protocol'

/** past this many models the menu gets a search box (cursor-agent lists ~190) */
const SEARCH_THRESHOLD = 8

/**
 * Combined model + reasoning-effort picker in one popup (Cursor's model menu).
 * The trigger shows "Model · Effort"; the popup lists models — scrollable, and
 * searchable once the catalog is big (cursor-agent exposes every effort/speed
 * variant as its own slug; the CLI has no notion of the GUI's pinned shortlist,
 * so search IS the curation) — and, when the backend supports a real effort
 * flag (claude --effort, codex model_reasoning_effort), the effort chips.
 *
 * `efforts` empty hides the effort section entirely (cursor); `onSetUltracode`
 * omitted hides the ultracode row (claude-only).
 */
export function ModelPicker({
  choices,
  model,
  effort,
  efforts,
  ultracode,
  onSetModel,
  onSetEffort,
  onSetUltracode
}: {
  choices: { value: string; label: string }[]
  model: string
  effort: string
  efforts: ModelChoice[]
  ultracode?: boolean
  onSetModel: (value: string) => void
  onSetEffort: (value: string) => void
  onSetUltracode?: (on: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // fresh open: clear the filter, focus search, bring the current model into view
  useEffect(() => {
    if (!open) return
    setQuery('')
    requestAnimationFrame(() => {
      searchRef.current?.focus()
      listRef.current?.querySelector('.model-menu-on')?.scrollIntoView({ block: 'center' })
    })
  }, [open])

  const searchable = choices.length > SEARCH_THRESHOLD
  const q = query.trim().toLowerCase()
  const filtered = q
    ? choices.filter(
        (c) => c.label.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)
      )
    : choices

  const pick = (value: string): void => {
    onSetModel(value)
    setOpen(false)
  }

  const modelLabel = choices.find((c) => c.value === model)?.label ?? choices[0].label
  const showEffort = efforts.length > 0
  // ultracode pins the session to xhigh — the chips no longer describe it
  const effortLabel = ultracode
    ? 'Ultracode'
    : (efforts.find((e) => e.value === effort)?.label ?? 'Auto')

  return (
    <div className="model-picker" ref={ref}>
      <button className="model-picker-trigger" title="Model & reasoning effort" onClick={() => setOpen((o) => !o)}>
        {modelLabel}
        {showEffort && <span className="model-picker-effort"> · {effortLabel}</span>}
        <span className="model-picker-caret">⌄</span>
      </button>
      {open && (
        <div className="model-menu">
          <div className="model-menu-label">Model</div>
          {searchable && (
            <input
              ref={searchRef}
              className="model-menu-search"
              placeholder={`Search ${choices.length} models…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered.length > 0) pick(filtered[0].value)
                if (e.key === 'Escape') setOpen(false)
              }}
            />
          )}
          <div className="model-menu-list" ref={listRef}>
            {filtered.map((c) => (
              <button
                key={c.value}
                className={'model-menu-item' + (c.value === model ? ' model-menu-on' : '')}
                onClick={() => pick(c.value)}
              >
                <span className="model-menu-check">{c.value === model ? '✓' : ''}</span>
                {c.label}
              </button>
            ))}
            {filtered.length === 0 && <div className="model-menu-empty">No models match “{query}”</div>}
          </div>
          {showEffort && (
            <>
              <div className="model-menu-sep" />
              <div className="model-menu-label">Reasoning effort</div>
              <div className="model-menu-efforts">
                {efforts.map((e) => (
                  <button
                    key={e.value}
                    className={
                      'effort-chip' +
                      (e.value === effort ? ' effort-chip-on' : '') +
                      (ultracode ? ' effort-chip-muted' : '')
                    }
                    disabled={ultracode}
                    onClick={() => onSetEffort(e.value)}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {onSetUltracode && (
            <>
              <div className="model-menu-sep" />
              <label className="model-menu-ultra">
                <input
                  type="checkbox"
                  checked={!!ultracode}
                  onChange={(e) => onSetUltracode(e.target.checked)}
                />
                <span className="model-menu-ultra-text">
                  Ultracode
                  <span className="model-menu-ultra-hint">
                    xhigh effort + standing multi-agent orchestration
                  </span>
                </span>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  )
}
