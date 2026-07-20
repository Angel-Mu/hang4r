import { test, expect } from '@playwright/test'
import { basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * "Create PR" for an SSH session: sessionManager.createSessionPr must run
 * commit → branch → push → `gh pr create` over the remote Exec seam instead
 * of refusing SSH sessions outright.
 *
 * Proven end-to-end with a PATH-shimmed fake `ssh` (ignores its flags and
 * runs the last argument locally via `sh -c`, so the "remote" directory is
 * really just a scratch repo on disk) plus fake `claude` (satisfies the SSH
 * preflight's version check) and `gh` (prints a deterministic fake PR URL)
 * binaries in the same shim directory.
 */

/** Build a temp dir of fake `ssh`/`claude`/`gh` binaries and return its path. */
function makeShim(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hang4r-fakebin-'))
  const write = (name: string, body: string): void => {
    const p = join(dir, name)
    writeFileSync(p, body)
    chmodSync(p, 0o755)
  }
  // Fake $SHELL: ignores its flags (-lc etc.) and runs its LAST argument via
  // `sh -c`. Used in place of a real login shell so a developer's actual
  // $SHELL (which may not even support `-lc`, e.g. fish) and its profile
  // scripts never get involved — PATH flows through untouched.
  write('fakeshell', '#!/bin/bash\nlast="${!#}"\nexec sh -c "$last"\n')
  // Fake ssh: point $SHELL at fakeshell above, then run ITS last argument
  // locally too — sessionManager's remote commands land on this real host.
  write(
    'ssh',
    `#!/bin/bash\nexport SHELL="${join(dir, 'fakeshell')}"\nlast="\${!#}"\nexec sh -c "$last"\n`
  )
  // Fake claude: satisfies the ssh-session preflight's "claude --version" check.
  write('claude', '#!/bin/bash\necho "1.0.0 (Claude Code)"\n')
  // Fake gh: satisfies createSessionPr's "gh pr create" call.
  write('gh', '#!/bin/bash\necho "https://github.com/fake/repo/pull/1"\n')
  return dir
}

test.describe('create PR on an SSH session', () => {
  let launched: LaunchedApp
  let originalPath: string | undefined

  test.afterEach(async () => {
    await launched?.app.close()
    if (originalPath !== undefined) process.env.PATH = originalPath
  })

  test('pushes and opens a PR over the remote Exec seam', async () => {
    const shimDir = makeShim()
    originalPath = process.env.PATH
    process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`

    // The fake ssh runs commands locally, so the "remote" directory is just
    // a real scratch repo — give it a real "origin" to push to as well.
    const repo = makeScratchRepo()
    const bareOrigin = mkdtempSync(join(tmpdir(), 'hang4r-bare-'))
    execFileSync('git', ['init', '--bare', bareOrigin])
    execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: repo })

    launched = await launchApp()
    const { page } = launched

    await createProject(page, repo)
    // one configured host, its "remote dir" is really our local scratch repo
    await page.evaluate(
      (hosts) => window.hang4r.setSetting('sshHosts', JSON.stringify(hosts)),
      [{ id: 'fake-host-1', label: 'Fake Host', host: 'fakehost', dir: repo }]
    )
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-name')).toHaveText(basename(repo))

    // Real UI flow: open the new-session dialog, pick the SSH environment
    // (only offered once a host is configured), start the agent.
    await page.locator('.project-row .ghost-btn').first().click()
    await expect(page.locator('.dialog')).toBeVisible()
    // pick the SSH environment (a segmented button, only offered w/ a host)
    await page.getByRole('button', { name: 'SSH remote' }).click()
    await page.locator('.dialog-prompt').fill('ssh pr test')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    await tile.getByRole('button', { name: 'Diff' }).click()
    await expect(tile.locator('.diff-actions button', { hasText: 'PR' })).toBeVisible()
    await tile.locator('.diff-actions button', { hasText: 'PR' }).click()
    // PR now OPENS the pull request in the browser pane ("bring us to the
    // changes"), so the Browser context surfaces with the PR URL loaded.
    await expect(tile.locator('.browser-url')).toHaveValue(
      'https://github.com/fake/repo/pull/1',
      { timeout: 20_000 }
    )
  })
})
