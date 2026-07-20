import type { BackendId, ModelChoice } from '../../shared/protocol'

/**
 * `model[context=1m]` / `model[context=200k,effort=high]` — an explicit size
 * hint embedded in the model string. Not a cursor-agent convention we've
 * observed live; this exists so any future bracket-annotated model id (ours
 * or upstream) is honored instead of silently ignored. k/m suffixes only.
 */
export function parseBracketContextOverride(model: string): number | undefined {
  const m = model.match(/\[[^\]]*\bcontext\s*=\s*(\d+(?:\.\d+)?)\s*(k|m)?\b[^\]]*\]/i)
  if (!m) return undefined
  const value = parseFloat(m[1])
  const suffix = m[2]?.toLowerCase()
  const mult = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1
  return Math.round(value * mult)
}

/**
 * cursor-agent's own `--list-models` output sometimes embeds the window size
 * directly in the model's display label (verified live: the label for
 * `claude-fable-5-thinking-high` is "Fable 5 1M Thinking (NO ZDR)"). Session
 * init events carry that same display string as `model` (see cursorAdapter.ts
 * raw.model), so a bare "1M"/"200K"-style token in the string is a
 * self-reported hint straight from the installed CLI — more authoritative
 * than any doc page, since it reflects the account's actual catalog. Requires
 * a word-bounded `<number><k|m>` token so plain version numbers like
 * "gpt-5.2" or "composer-2.5" never match.
 */
function extractSelfReportedWindow(model: string): number | undefined {
  const m = model.match(/(?<![\w.])(\d+(?:\.\d+)?)\s*(k|m)(?![a-z])/i)
  if (!m) return undefined
  const value = parseFloat(m[1])
  const mult = m[2].toLowerCase() === 'm' ? 1_000_000 : 1_000
  return Math.round(value * mult)
}

/** lowercase, spaces→dashes — so a display name ("Composer 2.5") and a slug
 * ("composer-2.5") compare equal wherever we match on model identity. */
export function normalizeCursorModelName(model: string): string {
  return model.trim().toLowerCase().replace(/\s+/g, '-')
}

/**
 * Context-window size (tokens) for a model — drives the per-session context %.
 * Current Claude models (Opus 4.8 / Sonnet 5 / Fable 5) are 1M; only Haiku is
 * 200K. Codex reports the exact window in token usage events; these GPT values
 * come from the dynamic Codex model catalog when available.
 *
 * Cursor: verified 2026-07-12 against cursor.com/docs/models,
 * cursor.com/docs/context/max-mode, the Composer 2.5 changelog/blog, and
 * Cursor staff forum replies — none publish a fixed per-model context window.
 * The models table page claims "shows each model's maximum context size" but
 * the column isn't present in the rendered/static page. The one official
 * number that exists is generic, not per-model: Max Mode docs state
 * "the default context window ~200k tokens" and that Max Mode "extends the
 * context window to the maximum a model supports" — extension amount
 * undisclosed, and cursor-agent has no CLI flag to report or toggle Max Mode
 * (only `--model`), so we can't tell which state a given session is in. A
 * blanket 200k default would also be actively wrong for self-reported
 * extended variants (e.g. "Fable 5 1M Thinking" — see
 * extractSelfReportedWindow above), so no static per-family table is shipped.
 * We only ever report a window we can point to: a bracket override, or a
 * size cursor-agent's own catalog already spelled out in the model string.
 */
export function contextWindow(
  model: string | null | undefined,
  backend?: BackendId,
  models: ModelChoice[] = []
): number | undefined {
  const m = (model ?? '').toLowerCase()
  const catalogWindow = models.find((choice) => choice.value.toLowerCase() === m)?.contextWindowTokens
  if (catalogWindow) return catalogWindow
  if (backend === 'cursor') {
    const raw = model ?? ''
    return parseBracketContextOverride(raw) ?? extractSelfReportedWindow(raw)
  }
  // Codex reports (or doesn't) its own window; no static Claude fallback
  if (backend === 'codex') return undefined
  if (m.includes('haiku')) return 200_000
  if (m.includes('fable') || m.includes('opus') || m.includes('sonnet') || m.includes('mythos'))
    return 1_000_000
  // default/unknown: current Claude Code default is a 1M-context model
  return 1_000_000
}
