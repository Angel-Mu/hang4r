import { useMemo } from 'react'
import type { ModelChoice } from '@shared/protocol'
import { resolveClaudeModels } from '@shared/claudeModels'
import { useApp } from '../state/store'

/** the desktop's useClaudeModels: every alias carries a version, and a session's
 *  CLI-resolved model overrides the shipped lineup for its family */
export function useClaudeModels(): ModelChoice[] {
  const sessions = useApp((s) => s.sessions)
  const sessionInit = useApp((s) => s.sessionInit)
  return useMemo(() => resolveClaudeModels(sessions, sessionInit), [sessions, sessionInit])
}
