/**
 * Find bars are INDEPENDENT per scope. The conversation, each open file, each
 * terminal, and the browser pane each keep their OWN find bar — opening one no
 * longer closes the others (Angel: "every search on its own scope"; a file
 * search must not close the conversation's, and two files can search at once).
 *
 * This used to enforce a single app-wide bar (old QA hunt #11), but that
 * conflated distinct scopes. Each bar already owns its state and clears its own
 * highlights on close, so several can coexist safely. The functions are kept as
 * no-ops so the scope components (ChatFindBar / EditorFindBar / TerminalFindBar)
 * need no changes at their call sites.
 */
type Closer = () => void

/** No-op: opening a find bar no longer closes the others (scopes are independent). */
export function claimFind(_close: Closer): void {
  /* intentionally empty — see module doc */
}

/** No-op counterpart to {@link claimFind}. */
export function releaseFind(_close: Closer): void {
  /* intentionally empty — see module doc */
}
