/**
 * The sidebar's order, shared by the desktop Sidebar and the phone's home list
 * so the two can't drift.
 */

export type ProjectSort = 'name' | 'recent'

/** The desktop's sidebar settings, as the phone receives them. */
export interface SidebarLayout {
  pinnedProjects: string[]
  projectOrder: string[]
  projectSort: ProjectSort
  pinnedSessions: string[]
  collapsedProjects: string[]
}

/** Pinned workspaces first, then the manual drag order, then the chosen sort
 *  ('recent' = latest session activity among `sessions`). */
export function orderProjects<P extends { id: string; name: string }>(
  projects: P[],
  sessions: { projectId: string; updatedAt: number }[],
  layout: Pick<SidebarLayout, 'pinnedProjects' | 'projectOrder' | 'projectSort'>
): P[] {
  const lastActivity = (projectId: string): number =>
    Math.max(0, ...sessions.filter((s) => s.projectId === projectId).map((s) => s.updatedAt))
  const orderIndex = (id: string): number => {
    const i = layout.projectOrder.indexOf(id)
    return i === -1 ? Number.POSITIVE_INFINITY : i
  }
  return [...projects].sort((a, b) => {
    const ap = layout.pinnedProjects.includes(a.id)
    const bp = layout.pinnedProjects.includes(b.id)
    if (ap !== bp) return ap ? -1 : 1
    const ai = orderIndex(a.id)
    const bi = orderIndex(b.id)
    if (ai !== bi) return ai - bi
    return layout.projectSort === 'name'
      ? a.name.localeCompare(b.name)
      : lastActivity(b.id) - lastActivity(a.id)
  })
}

/** Pinned sessions first, then most recently active. */
export function orderSessions<S extends { id: string; updatedAt: number }>(
  sessions: S[],
  isPinned: (id: string) => boolean
): S[] {
  return [...sessions].sort((a, b) => {
    const pa = isPinned(a.id) ? 1 : 0
    const pb = isPinned(b.id) ? 1 : 0
    if (pa !== pb) return pb - pa
    return b.updatedAt - a.updatedAt
  })
}
