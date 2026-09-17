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

/** A question and the choices offered for it. */
export interface QuickQuestion {
  /** the question line itself, shown above the choices */
  question: string
  options: QuickReply[]
}

// the bold may wrap the label alone (**A**)) or label and punctuation (**A)**)
// the bold may wrap the label alone (**A**)) or label and punctuation (**A)**)
const OPTION_LINE = /^[ \t]*(?:[-*]\s*)?(?:\*\*)?([A-Z])(?:\*\*)?[).:](?:\*\*)?\s+(.{3,200}?)\s*$/

/**
 * Answer choices for the LAST question in a message.
 *
 * Two things make this hard, and Angel hit both. Agents ask, list the choices,
 * then add a recommendation — so the question is not the last line. And a long
 * message is full of numbered lists that are CONTENT, not answers: his "Two
 * rules: 1… 2…" and a list of screens both became buttons under a looser rule.
 *
 * So: the last question line, not the first. Lettered labels only, because a
 * numbered list in prose is almost always content. And the choices must begin
 * within a couple of lines of the question — an answer sits under what it
 * answers, while content is separated by headings and paragraphs.
 */
export function quickReplies(text: string): QuickQuestion {
  const none: QuickQuestion = { question: '', options: [] }
  if (!text) return none
  const lines = text.split('\n')

  let askedAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (/\?$/.test(l) && l.length > 1) {
      askedAt = i
      break
    }
  }
  if (askedAt < 0) return none

  // The choices sit next to the question, on whichever side the agent put them:
  // "which is it?" then A/B/C, or A/B/C then "A, B, or C?" as a closing line.
  // Only the ADJACENT block counts — content further away answers nothing.
  const collect = (from: number, step: -1 | 1): Map<string, string> => {
    const found = new Map<string, string>()
    let gap = 0
    for (let i = from; i >= 0 && i < lines.length; i += step) {
      const line = lines[i]
      if (!line.trim()) {
        if (found.size > 0) break
        if (++gap > 1) break
        continue
      }
      const m = OPTION_LINE.exec(line)
      if (!m) {
        if (found.size > 0) break // prose past the block (a recommendation) is fine
        if (++gap > 1) break
        continue
      }
      if (!found.has(m[1])) {
        // strip emphasis and a trailing clause so the face stays readable
        found.set(m[1], m[2].replace(/\*\*/g, '').replace(/\s*—.*$/, '').trim())
      }
    }
    return found
  }

  let titleAt = askedAt
  let seen = collect(askedAt + 1, 1)
  if (seen.size < 2) {
    const above = new Map([...collect(askedAt - 1, -1).entries()].reverse())
    // Choices ABOVE the question only count when the question points at them —
    // "A, B, or C?" does, "does that look right?" does not. Without this, a list
    // the agent had already decided between became buttons.
    const q = lines[askedAt]
    const named = [...above.keys()].filter((l) => new RegExp(`\\b${l}\\b`).test(q)).length
    if (named >= 2 || /\b(which|pick|choose)\b/i.test(q)) {
      seen = above
      // "A, B, or C?" restates the choices; the real question is above them, and
      // that is the line worth showing as the title
      for (let i = askedAt - 1; i >= 0; i--) {
        const l = lines[i].trim()
        if (/\?$/.test(l) && l.length > 1 && !OPTION_LINE.test(lines[i])) {
          titleAt = i
          break
        }
      }
    }
  }
  if (seen.size < 2) return none
  if (![...seen.keys()].every((l) => /^[A-Z]$/.test(l))) return none

  return {
    question: lines[titleAt].trim(),
    options: [...seen.entries()].map(([label, face]) => ({ value: label, text: face }))
  }
}
