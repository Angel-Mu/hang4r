import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A file the agent wrote OUTSIDE the worktree — an absolute /tmp path, or a
 * ~/.claude-style path in the user's home — must be readable for preview. That's
 * where a clicked out-of-tree path now routes (instead of the old silent blank
 * editor tab). Exercises FileService.previewAttachment through the bridge for the
 * two forms the empty-editor bug hit: absolute-external, and ~-expansion.
 */
test('out-of-tree files (absolute + ~) are previewable, not a blank editor', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  const rand = Math.random().toString(36).slice(2, 10)
  const ootDir = join(tmpdir(), `hang4r-oot-${rand}`)
  const homeDir = join(homedir(), `.hang4r-e2e-${rand}`) // NOT ~/.claude — namespaced + cleaned up
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('oot preview')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    const session = await page.evaluate(async () => {
      const s = (await window.hang4r.listSessions())[0]
      return { id: s.id, cwd: s.cwd }
    })
    const sessionId = session.id

    // (1) absolute out-of-tree file (the /tmp case) → read verbatim
    mkdirSync(ootDir, { recursive: true })
    const absMarker = `ABS_OOT_${rand}_readable_body`
    const absPath = join(ootDir, 'preview.md')
    writeFileSync(absPath, `# out of tree\n\n${absMarker}\n`)
    const absRes = await page.evaluate(
      (a) => window.hang4r.previewAttachment(a.sid, a.p, true),
      { sid: sessionId, p: absPath }
    )
    expect(absRes?.kind).toBe('markdown')
    expect(absRes?.text ?? '').toContain(absMarker)

    // (2) ~-relative file in $HOME (the ~/.claude case) → must expand ~, not join
    // it onto the worktree (which produced <worktree>/~/… → ENOENT → blank editor)
    mkdirSync(homeDir, { recursive: true })
    const homeMarker = `HOME_TILDE_${rand}_readable_body`
    writeFileSync(join(homeDir, 'home.md'), `# home\n\n${homeMarker}\n`)
    const tildeRes = await page.evaluate(
      (a) => window.hang4r.previewAttachment(a.sid, a.p, true),
      { sid: sessionId, p: `~/.hang4r-e2e-${rand}/home.md` }
    )
    expect(tildeRes?.text ?? '').toContain(homeMarker)

    // (3) a bare name that actually lives in a SUBDIR (e.g. clicking
    // "settings.local.json" that's really at .claude/settings.local.json) →
    // resolve by unique basename within the project, not a "couldn't open" miss
    // write into the session's ACTUAL cwd (a worktree by default), not `repo`
    mkdirSync(join(session.cwd, 'nested-dir'), { recursive: true })
    const subMarker = `SUBDIR_BASENAME_${rand}_readable_body`
    writeFileSync(join(session.cwd, 'nested-dir', `deep-${rand}.md`), `# nested\n\n${subMarker}\n`)
    const subRes = await page.evaluate(
      (a) => window.hang4r.previewAttachment(a.sid, a.p, true),
      { sid: sessionId, p: `deep-${rand}.md` } // bare name, not the subdir path
    )
    expect(subRes?.text ?? '').toContain(subMarker)
  } finally {
    rmSync(ootDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
    await launched.app.close()
  }
})
