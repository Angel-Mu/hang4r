import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The new-session modal can attach files to the FIRST prompt. Attachments flow
 * through createSession the same way the composer sends follow-ups: firstPrompt
 * carries the agent-facing text with the file bytes fenced in, while firstFiles
 * + firstDisplayText drive the transcript's file cards. This verifies the
 * create→first-turn plumbing renders the card and hides the raw bytes. (The
 * modal's native OS file picker itself can't be driven in e2e — the preload
 * bridge is contextBridge-frozen — so we exercise the bridge createSession that
 * the modal calls.)
 */
test('files attached to a new session render as a card in the first turn', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    const { id: projectId } = await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    const marker = 'FIRSTTURN_FILE_BYTES_z9y8'
    await page.evaluate(
      (a) =>
        window.hang4r.createSession({
          projectId: a.projectId,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'attach first turn',
          firstPrompt: `notes.md:\n\`\`\`\n# Notes\n${a.marker}\n\`\`\`\n\nlook at this file`,
          firstFiles: [{ name: 'notes.md', path: 'notes.md' }],
          firstDisplayText: 'look at this file'
        }),
      { projectId, marker }
    )

    // the bridge-created session appears in the sidebar — open it
    await page.locator('.session-row', { hasText: 'attach first turn' }).first().click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // first turn shows a FILE CARD (name + MD badge) + the typed text, and NOT
    // the raw fenced bytes (those go to the agent only, via firstPrompt)
    const card = tile.locator('.msg-user-file', { hasText: 'notes.md' }).first()
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('.msg-user-file-badge')).toHaveText('MD')
    const userMsg = tile.locator('.msg-user-card', { hasText: 'look at this file' }).first()
    await expect(userMsg).toBeVisible()
    await expect(userMsg).not.toContainText(marker)
  } finally {
    await launched.app.close()
  }
})
