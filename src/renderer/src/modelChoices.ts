import type { BackendId, ModelChoice } from '../../shared/protocol'

export const CLAUDE_MODELS: ModelChoice[] = [
  { value: '', label: 'Default model' },
  { value: 'opus', label: 'Opus 4.8' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'fable', label: 'Fable 5' },
  { value: 'haiku', label: 'Haiku 4.5' }
]

export const FALLBACK_CODEX_MODELS: ModelChoice[] = [
  { value: '', label: 'Default model' }
]

export const FALLBACK_CURSOR_MODELS: ModelChoice[] = [
  { value: '', label: 'Default model' }
]

export const DEFAULT_MODELS: Record<BackendId, ModelChoice[]> = {
  claude: CLAUDE_MODELS,
  codex: FALLBACK_CODEX_MODELS,
  cursor: FALLBACK_CURSOR_MODELS
}
