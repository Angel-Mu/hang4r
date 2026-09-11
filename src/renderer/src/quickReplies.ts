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
 * Only a message that ENDS by asking counts. An agent listing options while it
 * reasons is not waiting on you, and turning that into buttons would invite an
 * answer to a question it never asked.
 */
export function quickReplies(text: string): QuickReply[] {
  if (!text) return []
  const lines = text.split('\n')
  const tail = lines.slice(-6).join(' ')
  if (!/\?\s*$/.test(text.trimEnd()) && !/\b(which|pick|choose|A,\s*B)\b/i.test(tail)) return []

  const seen = new Map<string, string>()
  for (const line of lines) {
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
