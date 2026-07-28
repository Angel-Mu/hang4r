import { useMemo } from 'react'
import type { ModelChoice } from '../../shared/protocol'
import { useHang4r } from './state/store'
import { CLAUDE_MODELS, CURRENT_CLAUDE_VERSIONS, prettifyClaudeModelId } from './modelChoices'

/**
 * Claude model choices with a version on every label. Priority per alias:
 *  1. the CLI's ACTUAL resolved model, learned from a session's init event
 *     (`claude-opus-5-…` → "Opus 5") — authoritative, self-correcting;
 *  2. else today's known lineup (CURRENT_CLAUDE_VERSIONS) so an alias the current
 *     session hasn't run still shows its version (Angel: only the running "Fable 5"
 *     had a number);
 *  3. else the version-agnostic base label (Default, or an unknown future alias).
 * (1) overrides (2), so when the CLI ships a newer model the first run relabels it.
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
      if (rid && rid.startsWith('claude-')) {
        const pretty = prettifyClaudeModelId(rid)
        return { ...m, label: m.value === '' ? `Default · ${pretty}` : pretty }
      }
      const known = CURRENT_CLAUDE_VERSIONS[m.value]
      return known ? { ...m, label: known } : m
    })
  }, [sessions, sessionInit])
}
