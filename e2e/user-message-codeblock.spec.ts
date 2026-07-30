import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * A user message that contains a ``` code fence renders as markdown (a real code
 * block) instead of showing the literal backticks (Angel: code blocks typed in
 * the input box displayed as raw ```). Plain prose stays verbatim.
 */
test('a user message with a code fence renders a code block, not literal backticks', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('codeblock test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // a fenced message
    await tile.locator('.composer-input').fill('here is code:\n```\nconst answer = 42\n```')
    await tile.getByRole('button', { name: 'Send' }).click()

    const card = tile.locator('.msg-user-card', { hasText: 'const answer = 42' }).first()
    await expect(card).toBeVisible({ timeout: 5_000 })
    // rendered as markdown with a real code block…
    await expect(card.locator('.msg-user-md')).toBeVisible()
    await expect(card.locator('.msg-user-md pre')).toContainText('const answer = 42')
    // …and the literal ``` fence is NOT shown as text
    await expect(card).not.toContainText('```')
  } finally {
    await launched.app.close()
  }
})
