import { useMemo } from 'react'
import type { ModelChoice } from '../../shared/protocol'
import { useHang4r } from './state/store'
import { resolveClaudeModels } from './modelChoices'

/**
 * Claude model choices with a version on every label. Priority per alias:
 *  1. the CLI's ACTUAL resolved model, learned from a session's init event
 *     (`claude-opus-5-…` → "Opus 5") — authoritative, self-correcting, but ONLY
 *     when the resolved id is the SAME family as the alias (a session switched to
 *     another alias keeps its stale init id — see resolveClaudeModels);
 *  2. else today's known lineup (CURRENT_CLAUDE_VERSIONS) so an alias the current
 *     session hasn't run still shows its version;
 *  3. else the version-agnostic base label.
 * Pure logic lives in resolveClaudeModels so it's unit-testable.
 */
export function useClaudeModels(): ModelChoice[] {
  const sessions = useHang4r((s) => s.sessions)
  const sessionInit = useHang4r((s) => s.sessionInit)
  return useMemo(() => resolveClaudeModels(sessions, sessionInit), [sessions, sessionInit])
}
