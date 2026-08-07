import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * iTerm-style terminal modes (terminalShellMode): 'custom' runs the chosen shell
 * as a LOGIN shell (-l) — sources ~/.zprofile / PATH like Terminal.app / iTerm
 * (Angel). We prove the -l flag actually reaches the shell with a wrapper that
 * echoes its argv. ('command' mode would spawn it WITHOUT -l.)
 */
test('terminalShellMode custom spawns the chosen shell with -l', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  const dir = join(tmpdir(), `hang4r-shell-${Math.random().toString(36).slice(2, 8)}`)
  try {
    mkdirSync(dir, { recursive: true })
    const wrapper = join(dir, 'echoargs.sh')
    // echo the argv we were spawned with, then hand off to a live shell so the
    // terminal stays open and the echoed line remains in the buffer
    writeFileSync(wrapper, '#!/bin/bash\necho "SHELLARGV[$*]"\nexec /bin/bash --norc -i\n', {
      mode: 0o755
    })

    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-name')).toHaveText(basename(repo))
    await page.evaluate(async (w) => {
      await window.hang4r.setSetting('terminalShell', w)
      await window.hang4r.setSetting('terminalShellMode', 'custom')
    }, wrapper)

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('login shell test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Terminal' }).click()
    const term = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(term.locator('.xterm')).toBeVisible({ timeout: 15_000 })

    // the wrapper printed the argv it was spawned with — a login shell gets -l
    await expect(term).toContainText('SHELLARGV[-l]', { timeout: 10_000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await launched.app.close()
  }
})
