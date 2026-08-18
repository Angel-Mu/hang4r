import { test, expect } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A run_in_background task must stop badging "running" once its OWN output file
 * shows it finished (exit marker) or was killed — even if the agent never
 * re-checked it (the launch's tool_result never flips, and nothing else did).
 * BackgroundTasks now polls backgroundTaskState(outputPath), which reads the
 * file's terminal markers (+ an lsof live-writer probe) and OVERRIDES the
 * collected 'running'. A per-task ■ Stop is offered while (and only while) a bash
 * task is actually running.
 *
 * The fake agent writes each task's log to <cwd>/.hang4r-bg-<turn>.log; we force
 * a LOCAL session so cwd is the repo root and the path is known. Markers are
 * written while the Tasks panel is CLOSED (nothing polls yet), then the panel is
 * opened so the first poll reads them — deterministic, no real process needed.
 * A third task is kept alive by a read fd this test holds open (so lsof reports a
 * live writer) to prove the running state + its Stop button; we never click that
 * Stop (its only "writer" is this test process).
 */
test('background task status reflects the output file (done/stopped) + per-task Stop', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page, userDataDir } = launched
  let liveFd: number | undefined
  try {
    const repo = makeScratchRepo()
    // force LOCAL env so the session runs at the repo root (known log path)
    mkdirSync(join(userDataDir, '.hang4r'), { recursive: true })
    writeFileSync(
      join(userDataDir, '.hang4r', 'settings.json'),
      JSON.stringify({ defaultEnvironment: 'local' })
    )
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // turn 1 → fake launches a run_in_background bash task writing .hang4r-bg-1.log
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('bg status test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    const log1 = join(repo, '.hang4r-bg-1.log')
    await expect.poll(() => existsSync(log1), { timeout: 15_000 }).toBe(true)

    // turn 2 (composer) → a SECOND bash task writing .hang4r-bg-2.log
    await tile.locator('.composer-input').fill('second bg task')
    await tile.locator('.composer-send').click()
    const log2 = join(repo, '.hang4r-bg-2.log')
    await expect.poll(() => existsSync(log2), { timeout: 20_000 }).toBe(true)
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // turn 3 (composer) → a THIRD bash task writing .hang4r-bg-3.log (kept alive)
    await tile.locator('.composer-input').fill('third bg task')
    await tile.locator('.composer-send').click()
    const log3 = join(repo, '.hang4r-bg-3.log')
    await expect.poll(() => existsSync(log3), { timeout: 20_000 }).toBe(true)
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Tasks panel is still CLOSED → nothing has polled yet. Write terminal markers
    // into logs 1 & 2, and hold log 3 open so lsof reports a live writer for it.
    appendFileSync(log1, '\n[exited with code 0]\n')
    appendFileSync(log2, '\ncaught signal\n[killed]\n')
    liveFd = openSync(log3, 'r')

    // opening the panel triggers the first poll for every running bash task
    await tile.getByRole('button', { name: 'Tasks', exact: true }).click()
    const bg1 = tile.locator('.bgtask').filter({ has: page.locator('.bgtask-id', { hasText: 'bg1' }) })
    const bg2 = tile.locator('.bgtask').filter({ has: page.locator('.bgtask-id', { hasText: 'bg2' }) })
    const bg3 = tile.locator('.bgtask').filter({ has: page.locator('.bgtask-id', { hasText: 'bg3' }) })

    // collected status is 'running'; the poll OVERRIDES it from the output file
    await expect(bg1.locator('.bgtask-status')).toHaveText('done', { timeout: 10_000 })
    await expect(bg2.locator('.bgtask-status')).toHaveText('stopped', { timeout: 10_000 })
    // still-live task stays running and offers a per-task ■ Stop
    await expect(bg3.locator('.bgtask-status')).toHaveText('running', { timeout: 10_000 })
    await expect(bg3.locator('.bgtask-stop')).toBeVisible()
    // terminal tasks offer no Stop button
    await expect(bg1.locator('.bgtask-stop')).toHaveCount(0)
    await expect(bg2.locator('.bgtask-stop')).toHaveCount(0)
  } finally {
    if (liveFd !== undefined) closeSync(liveFd)
    await launched.app.close()
  }
})
