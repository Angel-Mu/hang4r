import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * "Drop worktree" frees a worktree session's worktree on disk but KEEPS the
 * session live + its conversation searchable (unlike Archive). And — the core
 * of Angel's report — hang4r must NOT silently rebuild the worktree when the
 * session is merely opened/read afterward. Recreate re-provisions it on demand.
 */
async function createWorktreeSession(
  page: LaunchedApp['page'],
  projectId: string,
  title: string
): Promise<{ id: string; cwd: string; worktreeDropped?: boolean; status: string }> {
  return page.evaluate(
    ({ projectId, title }) =>
      window.hang4r.createSession({
        projectId,
        backend: 'claude',
        environment: 'worktree',
        permissionMode: 'default',
        title
      }),
    { projectId, title }
  )
}

test.describe('worktree drop / recreate', () => {
  let launched: LaunchedApp
  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('Drop frees the worktree + keeps the session; passive open does NOT resurrect it; Recreate rebuilds', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    const project = await createProject(page, repo)
    const session = await createWorktreeSession(page, project.id, 'FEAT-drop')
    expect(existsSync(session.cwd)).toBe(true)

    // Drop → worktree removed from disk (background), session flagged dropped and
    // still LIVE (not archived)
    const dropped = await page.evaluate((id) => window.hang4r.dropWorktree(id), session.id)
    expect(dropped?.worktreeDropped).toBe(true)
    expect(dropped?.status).not.toBe('archived')
    await expect.poll(() => existsSync(session.cwd), { timeout: 15_000 }).toBe(false)

    // PASSIVE access (listing files, as the file tree does on open) must NOT
    // rebuild the worktree — that resurrection is exactly the bug (Angel).
    await page.evaluate((id) => window.hang4r.listDir(id, '').catch(() => {}), session.id)
    await page.evaluate((id) => window.hang4r.listAllFiles(id).catch(() => {}), session.id)
    // if a passive read wrongly rebuilt it, existsSync would flip back to true and
    // this poll would time out
    await expect.poll(() => existsSync(session.cwd), { timeout: 5_000 }).toBe(false)

    // Recreate → back on disk, ready to continue working
    await page.evaluate((id) => window.hang4r.recreateWorktree(id), session.id)
    await expect.poll(() => existsSync(session.cwd), { timeout: 20_000 }).toBe(true)
  })
})
