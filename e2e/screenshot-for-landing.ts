/**
 * One-off: boot the real app with the fake agent, create sessions in a
 * scratch project, and capture the landing-page screenshots:
 *   landing/public/shots/workspace.png    — tiled workspace, two sessions
 *   landing/public/shots/diff-review.png  — diff tab open on tile 1
 *   landing/public/shots/new-agent.png    — the New Agent dispatch dialog
 *   landing/public/og.png                 — 1200×630 social card
 * Run after `npm run build`:  npx tsx e2e/screenshot-for-landing.ts
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, dragTo } from './helpers'

const SHOTS = join(__dirname, '..', 'landing', 'public', 'shots')
const OG = join(__dirname, '..', 'landing', 'public', 'og.png')

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const { app, page } = await launchApp()
  await page.setViewportSize({ width: 1440, height: 900 })

  const repo = makeScratchRepo()
  await createProject(page, repo)
  await page.reload()
  await page.waitForSelector('.app')

  // the landing page shows the dark UI
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })

  // session 1
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('Fix the flaky session-restore e2e test')
  await page.getByRole('button', { name: /Start agent/ }).click()
  await page.locator('.tile').first().waitFor()

  // session 2
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').fill('Polish the diff viewer hunk header styling')
  await page.getByRole('button', { name: /Start agent/ }).click()

  // split the workspace: drag the non-focused session onto the right half so
  // both agents are tiled side by side (the shot the landing page shows)
  await page.locator('.pane').first().waitFor()
  await page.locator('.session-row:not(.session-row-focused)').first().waitFor({ timeout: 15_000 })
  // tsx/esbuild injects __name helpers into functions serialized by evaluate;
  // the page doesn't have them — shim so dragTo's inner functions work
  await page.evaluate(() => {
    ;(globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f
  })
  await dragTo(page, '.session-row:not(.session-row-focused)', '.pane', 'right')
  await page.locator('.pane').nth(1).waitFor()

  // let both stream a few turns
  await page.waitForTimeout(4500)
  await page.screenshot({ path: join(SHOTS, 'workspace.png') })

  // diff tab open on tile 1
  const tile = page.locator('.tile').first()
  await tile.getByRole('button', { name: 'Diff' }).click().catch(() => {})
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(SHOTS, 'diff-review.png') })

  // the New Agent dialog (backend / model / permissions / worktree)
  await page.locator('.project-row .ghost-btn').first().click()
  await page.locator('.dialog-prompt').waitFor()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, 'new-agent.png') })
  await page.keyboard.press('Escape')

  // og card: 1200×630 of the workspace
  await tile.getByRole('button', { name: 'Files' }).click().catch(() => {})
  await page.setViewportSize({ width: 1200, height: 630 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: OG })

  await app.close()
  console.log(`saved shots to ${SHOTS} and ${OG}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
