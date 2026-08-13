import type { ModelChoice } from './protocol'

/**
 * Claude model aliases. The CLI has no model-catalog command, but `--model
 * <alias>` always resolves to the LATEST model in each family (per `claude
 * --help`: 'opus'/'sonnet'/'fable' are "an alias for the latest model"). So we
 * ship version-AGNOSTIC labels — hard-coding "Opus 4.8" goes stale the moment
 * the CLI's opus points at Opus 5 (Angel: hang4r showed 4.8 while his CLI had 5).
 * useClaudeModels() then swaps in the REAL resolved version (e.g. "Opus 5") once
 * a session's init event reports it — genuinely read from the CLI, never stale.
 * Shared (not renderer-local) so the mobile app offers the same picker.
 */
export const CLAUDE_MODELS: ModelChoice[] = [
  { value: '', label: 'Default model' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'fable', label: 'Fable' },
  { value: 'haiku', label: 'Haiku' }
]

/**
 * Today's Claude lineup — shown so EVERY alias carries a version immediately, not
 * just the one the current session happens to run (Angel: only "Fable 5" showed a
 * number). This is a sensible DEFAULT, not a fixed label like the old "Opus 4.8":
 * the moment a session runs an alias, useClaudeModels swaps in the CLI's ACTUAL
 * resolved version and it self-corrects (so when opus points at a newer model,
 * the first run relabels it). Bump when the CLI's lineup changes.
 */
export const CURRENT_CLAUDE_VERSIONS: Record<string, string> = {
  opus: 'Opus 5',
  sonnet: 'Sonnet 5',
  fable: 'Fable 5',
  haiku: 'Haiku 4.5'
}

/**
 * Turn a resolved Claude model id into a display name:
 * `claude-opus-5-20260115` → "Opus 5", `claude-haiku-4-5-20251001` → "Haiku 4.5".
 * Numeric segments up to the date/suffix become the version; the rest is dropped.
 */
export function prettifyClaudeModelId(id: string): string {
  const parts = id.replace(/^claude-/, '').split('-')
  const family = parts.shift() ?? ''
  const cap = family ? family.charAt(0).toUpperCase() + family.slice(1) : id
  const ver: string[] = []
  for (const p of parts) {
    if (/^\d{1,2}$/.test(p))
      ver.push(p) // version segment; an 8-digit date stops it
    else break
  }
  return ver.length ? `${cap} ${ver.join('.')}` : cap
}
