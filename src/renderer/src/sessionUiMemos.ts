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

type Remap = (sessionId: string, from: string, to: string) => void
const remappers = new Set<Remap>()

/** A component registers to rewrite the absolute paths it memoized when a
 *  session's working directory MOVES (renaming a session renames its worktree).
 *  Without this the open tabs and their scroll positions still name the old
 *  folder, so every one of them reads as a missing file. */
export function onRemapSessionPaths(fn: Remap): void {
  remappers.add(fn)
}

export function remapSessionPaths(sessionId: string, from: string, to: string): void {
  for (const fn of remappers) fn(sessionId, from, to)
}

/** Swap a `${sessionId}:${absolutePath}` memo's key prefix in place. */
export function remapKeyedMemo<T>(
  memo: Map<string, T>,
  sessionId: string,
  from: string,
  to: string
): void {
  for (const [key, value] of [...memo]) {
    const path = key.startsWith(`${sessionId}:`) ? key.slice(sessionId.length + 1) : null
    if (path === null || !path.startsWith(from + '/')) continue
    memo.delete(key)
    memo.set(`${sessionId}:${to}${path.slice(from.length)}`, value)
  }
}

/** What a session's restorable UI state looks like on disk. */
export interface SessionUiSnapshot {
  /** FileBrowser layout (open files + split structure), serialized */
  layout?: unknown
  /** which context panel was active (Files / Diff / Terminal / Browser / …) */
  contextTab?: string | null
  /** toolUseIds of subagent runs the user COLLAPSED in the Subagents panel */
  collapsedSubagents?: string[]
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
