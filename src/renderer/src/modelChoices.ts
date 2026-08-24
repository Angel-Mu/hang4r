import type { BackendId, ModelChoice } from '../../shared/protocol'

/**
 * Reasoning-effort levels each backend actually accepts. Claude takes ours
 * verbatim (`--effort`); codex's `model_reasoning_effort` tops out at 'high' and
 * adds 'minimal'; cursor has no effort flag — its slugs bake effort in.
 */
export const EFFORT_LEVELS: Record<BackendId, ModelChoice[]> = {
  claude: [
    { value: '', label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Xhigh' },
    { value: 'max', label: 'Max' }
  ],
  codex: [
    { value: '', label: 'Auto' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
  ],
  cursor: []
}

export {
  CLAUDE_MODELS,
  CURRENT_CLAUDE_VERSIONS,
  prettifyClaudeModelId
} from '../../shared/claudeModels'
import { CLAUDE_MODELS, CURRENT_CLAUDE_VERSIONS, prettifyClaudeModelId } from '../../shared/claudeModels'

/**
 * Build the Claude picker labels from the base list + what each session's init
 * event ACTUALLY resolved to. Priority per alias: same-family resolved id >
 * CURRENT_CLAUDE_VERSIONS > version-agnostic base label.
 *
 * Family guard (Angel's bug): a resolved id only relabels an alias when it's the
 * SAME family. A session switched from e.g. fable to opus keeps its old fable
 * init id until it re-runs; without this guard `resolved['opus']` became the
 * fable id and the picker showed "Opus 5" as "Fable 5" (and duplicated it).
 * Default ('') takes whatever that session resolved.
 */
export function resolveClaudeModels(
  sessions: readonly { id: string; backend: BackendId; model?: string | null }[],
  sessionInit: Record<string, { model?: string } | undefined>
): ModelChoice[] {
  const resolved: Record<string, string> = {}
  for (const s of sessions) {
    if (s.backend !== 'claude') continue
    const rid = sessionInit[s.id]?.model
    if (!rid || !rid.startsWith('claude-')) continue
    const alias = s.model ?? ''
    if (alias === '' || rid.startsWith(`claude-${alias}-`) || rid === `claude-${alias}`) {
      resolved[alias] = rid
    }
  }
  return CLAUDE_MODELS.map((m) => {
    const rid = resolved[m.value]
    if (rid) {
      const pretty = prettifyClaudeModelId(rid)
      return { ...m, label: m.value === '' ? `Default · ${pretty}` : pretty }
    }
    const known = CURRENT_CLAUDE_VERSIONS[m.value]
    return known ? { ...m, label: known } : m
  })
}

export const FALLBACK_CODEX_MODELS: ModelChoice[] = [{ value: '', label: 'Default model' }]

export const FALLBACK_CURSOR_MODELS: ModelChoice[] = [{ value: '', label: 'Default model' }]

export const DEFAULT_MODELS: Record<BackendId, ModelChoice[]> = {
  claude: CLAUDE_MODELS,
  codex: FALLBACK_CODEX_MODELS,
  cursor: FALLBACK_CURSOR_MODELS
}
