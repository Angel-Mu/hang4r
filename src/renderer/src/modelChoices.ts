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
import { CLAUDE_MODELS } from '../../shared/claudeModels'

export const FALLBACK_CODEX_MODELS: ModelChoice[] = [{ value: '', label: 'Default model' }]

export const FALLBACK_CURSOR_MODELS: ModelChoice[] = [{ value: '', label: 'Default model' }]

export const DEFAULT_MODELS: Record<BackendId, ModelChoice[]> = {
  claude: CLAUDE_MODELS,
  codex: FALLBACK_CODEX_MODELS,
  cursor: FALLBACK_CURSOR_MODELS
}
