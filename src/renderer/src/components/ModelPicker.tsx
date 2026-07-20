import { useEffect, useRef, useState, type JSX } from 'react'

const EFFORTS = [
  { value: '', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Xhigh' },
  { value: 'max', label: 'Max' }
]

/** past this many models the menu gets a search box (cursor-agent lists ~190) */
const SEARCH_THRESHOLD = 8

/**
 * Combined model + reasoning-effort picker in one popup (Cursor's model menu).
 * The trigger shows "Model · Effort"; the popup lists models — scrollable, and
 * searchable once the catalog is big (cursor-agent exposes every effort/speed
 * variant as its own slug; the CLI has no notion of the GUI's pinned shortlist,
 * so search IS the curation) — and, when the backend supports a real effort
 * flag (claude --effort, codex model_reasoning_effort), the effort chips.
 */
export function ModelPicker({
  choices,
  model,
  effort,
  showEffort,
  onSetModel,
  onSetEffort
}: {
  choices: { value: string; label: string }[]
  model: string
  effort: string
  showEffort: boolean
  onSetModel: (value: string) => void
  onSetEffort: (value: string) => void
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
  const effortLabel = EFFORTS.find((e) => e.value === effort)?.label ?? 'Auto'

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
                {EFFORTS.map((e) => (
                  <button
                    key={e.value}
                    className={'effort-chip' + (e.value === effort ? ' effort-chip-on' : '')}
                    onClick={() => onSetEffort(e.value)}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
