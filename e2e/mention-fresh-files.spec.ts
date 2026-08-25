import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: files the agent wrote DURING the conversation couldn't be @-mentioned —
 * "@out/" and "@gen-" matched nothing while the file tree showed them right
 * there. Two causes: the list was read once when the tile mounted, and it
 * respected .gitignore (⌘P had already stopped doing that, for this same
 * reason).
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function idleSessionOn(page: LaunchedApp['page'], repo: string): Promise<void> {
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.dialog')).toBeHidden()
  await page.locator('.tile .status-dot.status-idle').first().waitFor({ timeout: 20_000 })
}

test('a file the agent writes mid-conversation becomes @-mentionable', async () => {
  launched = await launchApp()
  const { page } = launched
  await idleSessionOn(page, makeScratchRepo())

  const composer = page.locator('.composer-input')
  await composer.click()
  // the fake agent writes hang4r-fake-<turn>.txt during its turn
  await composer.fill('make a file')
  await composer.press('Enter')
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await composer.click()
  await composer.fill('@hang4r-fake')
  await expect(page.locator('.mention-menu')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.mention-menu')).toContainText('hang4r-fake-1.txt')
})

test('a gitignored file is @-mentionable too — the tree shows it, so the menu must', async () => {
  launched = await launchApp()
  const { page } = launched
  const repo = makeScratchRepo()
  // an output dir the agent writes into, ignored by git like a real build dir
  writeFileSync(join(repo, '.gitignore'), 'out/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'ignore out'], {
    cwd: repo
  })
  await idleSessionOn(page, repo)

  // written into the SESSION's worktree, AFTER the tile mounted — the way an
  // agent creates one mid-conversation
  const cwd = (await page.evaluate(() => window.hang4r.listSessions()))[0].cwd
  mkdirSync(join(cwd, 'out'), { recursive: true })
  writeFileSync(join(cwd, 'out', 'gen-20260825-122335.jpg'), 'x')

  const composer = page.locator('.composer-input')
  await composer.click()
  await composer.fill('do a turn')
  await composer.press('Enter')
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

  await composer.click()
  await composer.fill('@gen-')
  await expect(page.locator('.mention-menu')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.mention-menu')).toContainText('gen-20260825-122335.jpg')
})
