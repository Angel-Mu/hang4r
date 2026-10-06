/**
 * hang4r's own UI copy for a turn it generated itself. Stored as the user's
 * text before `label` existed, so replaying an old conversation would hand the
 * agent this string as if the user had typed it.
 */
export const AUTO_CONTINUE_LABEL = '↻ hang4r auto-recovery — continuing past an aborted turn'

/** what auto-recovery actually sends */
const AUTO_CONTINUE_TEXT = 'continue'

/**
 * What the user actually said, for anything that replays a conversation back to
 * an agent — retry, handoff seeds, rewind anchors. Reads `label`-era events
 * directly and repairs the ones recorded before it existed.
 */
export function sentUserText(ev: { text: string; label?: string }): string {
  return ev.text === AUTO_CONTINUE_LABEL ? AUTO_CONTINUE_TEXT : ev.text
}

/** what hang4r shows in the transcript */
export function shownUserText(ev: { text: string; label?: string }): string {
  return ev.label ?? ev.text
}
