import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * ⌘P quick-open must find a file that's in the tree even if it's gitignored — an
 * agent-authored doc can sit in a gitignored dir yet be right there in the
 * explorer, and ⌘P used to say "No files match" (Angel). It must still keep the
 * heavy build/dep dirs (node_modules) out.
 */
test.describe('⌘P finder — gitignored files', () => {
  let launched: LaunchedApp
  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('includeIgnored surfaces a gitignored user file but still skips node_modules', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndocs/plans/\n')
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'plans', 'session-note.md'), '# a doc the agent wrote\n')
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    const project = await createProject(page, repo)
    const session = await page.evaluate(
      (projectId) =>
        window.hang4r.createSession({
          projectId,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title: 'finder-ignored'
        }),
      project.id
    )

    // ⌘P list (includeIgnored=true): the gitignored doc IS there, node_modules NOT
    const finderList = await page.evaluate((id) => window.hang4r.listAllFiles(id, true), session.id)
    expect(finderList).toContain('docs/plans/session-note.md')
    expect(finderList.some((p) => p.includes('node_modules/'))).toBe(false)

    // default list (readSources / TS worker) still respects .gitignore
    const defaultList = await page.evaluate((id) => window.hang4r.listAllFiles(id), session.id)
    expect(defaultList).not.toContain('docs/plans/session-note.md')
  })
})
