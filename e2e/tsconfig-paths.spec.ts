import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The Monaco TS worker resolves alias imports (@app/*) to real types only if it's
 * fed the project's baseUrl + paths. hang4r reads them from tsconfig — following
 * `extends` (nx keeps the aliases in tsconfig.base.json) and tolerating JSONC —
 * so imported symbols stop showing as `any` (Angel).
 */
test.describe('tsconfig path aliases → TS worker', () => {
  let launched: LaunchedApp
  test.afterEach(async () => {
    await launched?.app.close()
  })

  const localSession = (page: import('@playwright/test').Page, projectId: string) =>
    page.evaluate(
      (id) =>
        window.hang4r.createSession({
          projectId: id,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title: 'ts'
        }),
      projectId
    )

  test('resolves extends + JSONC, returns absolute baseUrl and the paths', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    // nx shape: the aliases live in the base, the project tsconfig just extends it
    writeFileSync(
      join(repo, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@app/*': ['src/app/*'], '@lib': ['libs/lib/index.ts'] }
        }
      })
    )
    // JSONC on purpose: a line comment + a trailing comma must not break parsing
    writeFileSync(
      join(repo, 'tsconfig.json'),
      '{\n  // project config\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": { "jsx": "react" },\n}\n'
    )
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    const project = await createProject(page, repo)
    const session = await localSession(page, project.id)

    const tc = await page.evaluate((id) => window.hang4r.readTsconfig(id), session.id)
    expect(tc).not.toBeNull()
    expect(tc!.paths['@app/*']).toEqual(['src/app/*'])
    expect(tc!.paths['@lib']).toEqual(['libs/lib/index.ts'])
    // baseUrl '.' is relative to the base's dir (the repo root) → absolute repo path
    expect(tc!.baseUrl.startsWith('/')).toBe(true)
    expect(tc!.baseUrl.endsWith(repo.split('/').pop()!)).toBe(true)
  })

  test('returns null when the project has no path aliases', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react' } }))
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    const project = await createProject(page, repo)
    const session = await localSession(page, project.id)
    const tc = await page.evaluate((id) => window.hang4r.readTsconfig(id), session.id)
    expect(tc).toBeNull()
  })
})
