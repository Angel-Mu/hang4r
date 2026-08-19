import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * ⌘P quick-open ranking, highlight, and a trailing :line[:col] suffix — Angel's
 * three screenshot bugs:
 *   1. `addressResolution.service.ts:103` said "No files match" (the literal
 *      ":103" was matched against filenames). It must strip the suffix, match the
 *      bare file, and still rank it first.
 *   2. the exact file ranked BELOW its `.spec.ts` cousin — exact basename must win.
 *   3. a substring match highlighted only scattered subsequence chars — the whole
 *      matched run must bold contiguously.
 */
test.describe('⌘P finder — ranking, highlight, :line suffix', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  // fixtures in nested dirs: the exact file, its .spec.ts cousin (must NOT
  // outrank it), and a decoy sharing the "address" prefix.
  const FIXTURES: Record<string, string> = {
    'src/services/addressResolution.service.ts': 'export const resolve = (): number => 1\n',
    'src/services/addressResolution.service.spec.ts': "import './addressResolution.service'\n",
    'src/services/addressAttemptKeyMigration.service.ts': 'export const migrate = (): number => 2\n'
  }

  /** Fresh app + repo with the fixtures committed, a session, and the ⌘P finder open. */
  async function openFinder(): Promise<LaunchedApp['page']> {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    for (const [rel, content] of Object.entries(FIXTURES)) {
      const abs = join(repo, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'fixtures'], { cwd: repo })

    const project = await createProject(page, repo)
    const session = await page.evaluate(
      (projectId) =>
        window.hang4r.createSession({
          projectId,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title: 'finder'
        }),
      project.id
    )

    // focus the session and flip the ⌘P finder open via the store (the same flag
    // the ⌘P key handler flips) — drives the real component + its scoring/highlight
    await page.evaluate((id) => {
      ;(
        window as unknown as {
          __hang4r_store: { setState(s: { focusedSessionId: string; fileFinderOpen: boolean }): void }
        }
      ).__hang4r_store.setState({ focusedSessionId: id, fileFinderOpen: true })
    }, session.id)

    await page.waitForSelector('.palette-input')
    return page
  }

  test('exact basename ranks first with a contiguous highlight', async () => {
    const page = await openFinder()
    await page.fill('.palette-input', 'addressResolution.service.ts')

    // exact file wins over its .spec.ts cousin (files load async → auto-retry)
    const first = page.locator('.palette-item').first()
    await expect(first.locator('.finder-name')).toHaveText('addressResolution.service.ts')

    // ONE contiguous run bolded, not scattered subsequence chars: for an exact
    // basename hit every char of the name is a .finder-hit (join == the whole name)
    const hits = await first.locator('.finder-hit').allInnerTexts()
    expect(hits.join('')).toBe('addressResolution.service.ts')
  })

  test('a trailing :line[:col] still matches the file (not "No files match")', async () => {
    const page = await openFinder()
    await page.fill('.palette-input', 'addressResolution.service.ts:103')

    // the ":103" is stripped off the query, so the file still matches and ranks first
    await expect(page.locator('.palette-empty')).toHaveCount(0)
    const first = page.locator('.palette-item').first()
    await expect(first.locator('.finder-name')).toHaveText('addressResolution.service.ts')
  })
})
