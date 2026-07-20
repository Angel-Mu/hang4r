/**
 * Registry for per-session UI memos (editor view state, tab layout, active
 * context panel, dirty flags, ...). Those memos live as module-level Maps inside
 * components (SessionTile, FileBrowser, CodeEditor) so they survive remounts —
 * but they're renderer memory only, so they used to vanish on every app restart
 * / reload, losing which files & panel a session had open (Angel). Components
 * now also register SEEDERS here; the store loads the persisted snapshot on init
 * and seeds the memos BEFORE the tiles mount, and PRUNING on archive still
 * clears them. A neutral module so the store never imports component modules
 * (which import the store back).
 */
type Forget = (sessionId: string) => void

const forgetters = new Set<Forget>()

export function onForgetSession(fn: Forget): void {
  forgetters.add(fn)
}

export function forgetSessionUiState(sessionId: string): void {
  for (const fn of forgetters) fn(sessionId)
  // drop the on-disk copy too (worktree is gone)
  void window.hang4r.setSetting(`sessionUi:${sessionId}`, '')
}

/** What a session's restorable UI state looks like on disk. */
export interface SessionUiSnapshot {
  /** FileBrowser layout (open files + split structure), serialized */
  layout?: unknown
  /** which context panel was active (Files / Diff / Terminal / Browser / …) */
  contextTab?: string | null
}

type Seed = (sessionId: string, snap: SessionUiSnapshot) => void
const seeders = new Set<Seed>()

/** A component registers to receive persisted state for a session at startup. */
export function onSeedSessionUi(fn: Seed): void {
  seeders.add(fn)
}

/** Store calls this during init (before tiles mount) with each session's snapshot. */
export function seedSessionUi(sessionId: string, snap: SessionUiSnapshot): void {
  for (const fn of seeders) fn(sessionId, snap)
}

/**
 * Merge a partial UI snapshot into the session's persisted blob. Components call
 * this whenever their piece changes; read-modify-write is fine because it's rare
 * (open/close a file, switch panel) and each session has its own key.
 */
export async function persistSessionUi(
  sessionId: string,
  patch: SessionUiSnapshot
): Promise<void> {
  try {
    const key = `sessionUi:${sessionId}`
    const raw = await window.hang4r.getSetting(key)
    const cur = raw ? (JSON.parse(raw) as SessionUiSnapshot) : {}
    await window.hang4r.setSetting(key, JSON.stringify({ ...cur, ...patch }))
  } catch {
    /* persistence is best-effort — never break the UI over it */
  }
}
