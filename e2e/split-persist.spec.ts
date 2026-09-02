import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Angel: "I changed the size of the conversation and the file editor … then I go
 * to another session and the resize is lost when I come back."
 */
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function startSession(page: LaunchedApp['page'], title: string): Promise<void> {
  await page.locator('.project-row .ghost-btn.project-add').first().click()
  await page.locator('.dialog-prompt').fill(title)
  await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
  await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
}

test('a dragged chat/panel split survives switching sessions', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  await startSession(page, 'session-one')
  await startSession(page, 'session-two')

  // open the Files panel so there IS a split to drag
  const tile = page.locator('.tile').first()
  await tile.locator('.tile-tabs button', { hasText: /^Files$/ }).first().click()
  await expect(tile.locator('.files-view')).toBeVisible()

  const chat = tile.locator('.chat-panel')
  const before = (await chat.boundingBox())!.width

  // drag the divider left, making the conversation narrower
  const sep = tile.locator('.resize-handle-v').first()
  const box = (await sep.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 220, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()

  const dragged = (await chat.boundingBox())!.width
  expect(Math.abs(dragged - before)).toBeGreaterThan(80) // the drag took effect

  // away to the other session and back
  await page.locator('.session-row', { hasText: 'session-one' }).click()
  await expect(page.locator('.tile')).toHaveCount(1)
  await page.locator('.session-row', { hasText: 'session-two' }).click()
  const back = page.locator('.tile').first()
  if (!(await back.locator('.files-view').isVisible())) {
    await back.locator('.tile-tabs button', { hasText: /^Files$/ }).first().click()
  }
  await expect(back.locator('.files-view')).toBeVisible()

  const after = (await back.locator('.chat-panel').boundingBox())!.width
  expect(Math.abs(after - dragged)).toBeLessThan(24)
})
