import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * go-to-definition's git-grep fallback (used when the TS worker can't resolve a
 * symbol — common in big monorepos) used to return the FIRST match, which was
 * often a test/spec that redeclares the symbol, so ⌥-click jumped into specs
 * instead of the source (Angel). It must prefer a non-test file.
 */
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('findDefinition returns the source file, not a spec that redeclares the symbol', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  // Both files declare `myWidgetThing` with the SAME (function) pattern, so only
  // path ordering decides. `widget.spec.ts` sorts before `widget.ts`, so a naive
  // first-match returns the spec — the fix must skip it for the real source.
  writeFileSync(join(repo, 'src', 'widget.spec.ts'), 'function myWidgetThing() {\n  return 0 // TEST\n}\n')
  writeFileSync(join(repo, 'src', 'widget.ts'), 'export function myWidgetThing() {\n  return 1 // SOURCE\n}\n')

  const project = await createProject(page, repo)
  await page.evaluate(
    ({ pid }) =>
      window.hang4r.createSession({
        projectId: pid,
        backend: 'claude',
        environment: 'local',
        permissionMode: 'default',
        title: 'goto',
        firstPrompt: 'hi'
      }),
    { pid: project.id }
  )
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.session-row', { hasText: 'goto' }).click()
  await expect(page.locator('.tile .status-dot.status-idle').first()).toBeVisible({ timeout: 20_000 })

  const sid = await page.evaluate(
    () =>
      (window as unknown as { __hang4r_store: { getState(): { focusedSessionId: string } } })
        .__hang4r_store.getState().focusedSessionId
  )
  const def = await page.evaluate(
    (s) => window.hang4r.findDefinition(s, 'myWidgetThing'),
    sid
  )
  expect(def?.path).toBe('src/widget.ts')
})
