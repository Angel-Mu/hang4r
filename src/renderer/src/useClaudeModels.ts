import { useMemo } from 'react'
import type { ModelChoice } from '../../shared/protocol'
import { useHang4r } from './state/store'
import { CLAUDE_MODELS, prettifyClaudeModelId } from './modelChoices'

/**
 * Claude model choices with labels enriched from the CLI's ACTUAL resolved model.
 * The base labels are version-agnostic ("Opus"); each Claude session's init event
 * reports the real id it resolved to (e.g. `claude-opus-5-…`), which we learn per
 * alias and swap in as "Opus 5" — so the picker tracks whatever the installed CLI
 * actually runs instead of a hard-coded version that goes stale. Only genuine
 * `claude-*` ids enrich (a fresh install / fake e2e stays on the base labels).
 */
export function useClaudeModels(): ModelChoice[] {
  const sessions = useHang4r((s) => s.sessions)
  const sessionInit = useHang4r((s) => s.sessionInit)
  return useMemo(() => {
    const resolved: Record<string, string> = {}
    for (const s of sessions) {
      if (s.backend !== 'claude') continue
      const rid = sessionInit[s.id]?.model
      if (rid) resolved[s.model ?? ''] = rid
    }
    return CLAUDE_MODELS.map((m) => {
      const rid = resolved[m.value]
      if (!rid || !rid.startsWith('claude-')) return m
      const pretty = prettifyClaudeModelId(rid)
      return { ...m, label: m.value === '' ? `Default · ${pretty}` : pretty }
    })
  }, [sessions, sessionInit])
}
