/**
 * Options an agent offered in prose, so they can be clicked instead of retyped.
 *
 * AskUserQuestion — the tool that renders a real picker — is not given to agents
 * outside an interactive terminal: it has never fired once across Angel's 59
 * sessions. Agents ask in prose instead ("A, B, or C?"), so that is what this
 * reads, the same way the task board reads a markdown checklist.
 */
export interface QuickReply {
  /** what the user sends when picked: the label alone, e.g. "B" */
  value: string
  /** the option's text, for the button face */
  text: string
}

// the bold may wrap the label alone (**A**)) or label and punctuation (**A)**)
const OPTION_LINE = /^[ \t]*(?:[-*]\s*)?(?:\*\*)?([A-Z]|\d{1,2})(?:\*\*)?[).:](?:\*\*)?\s+(.{3,200}?)\s*$/

/**
 * A question is a line ending in "?" with labelled options BELOW it.
 *
 * Requiring the message to END with the question was too strict: agents ask,
 * list the choices, then add a recommendation, so the last line is prose and
 * Angel got no buttons on a real question. Order is what separates the two
 * cases — options that come BEFORE any question are the agent reasoning through
 * alternatives, and answering those would reply to something never asked.
 */
export function quickReplies(text: string): QuickReply[] {
  if (!text) return []
  const lines = text.split('\n')
  const askedAt = lines.findIndex((l) => /\?\s*$/.test(l.trim()) && l.trim().length > 1)
  if (askedAt < 0) return []

  const seen = new Map<string, string>()
  for (const line of lines.slice(askedAt + 1)) {
    const m = OPTION_LINE.exec(line)
    if (!m) continue
    const label = m[1]
    // strip markdown emphasis and a trailing sentence so the face stays short
    const face = m[2].replace(/\*\*/g, '').replace(/\s*—.*$/, '').trim()
    if (!seen.has(label)) seen.set(label, face)
  }
  if (seen.size < 2) return []

  const labels = [...seen.keys()]
  const allLetters = labels.every((l) => /^[A-Z]$/.test(l))
  const allDigits = labels.every((l) => /^\d+$/.test(l))
  if (!allLetters && !allDigits) return []

  return labels.map((label) => ({ value: label, text: `${label} · ${seen.get(label)}` }))
}
