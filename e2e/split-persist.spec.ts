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

async function dragDivider(
  page: LaunchedApp['page'],
  sel: string,
  dx: number
): Promise<void> {
  const box = (await page.locator(sel).first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + dx, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
}

async function openFiles(page: LaunchedApp['page']): Promise<void> {
  const tile = page.locator('.tile').first()
  if (!(await tile.locator('.files-view').isVisible())) {
    await tile.locator('.tile-tabs button', { hasText: /^Files$/ }).first().click()
  }
  await expect(tile.locator('.files-view')).toBeVisible()
}

const chatWidth = async (page: LaunchedApp['page']): Promise<number> =>
  (await page.locator('.tile .chat-panel').boundingBox())!.width

test('each session keeps its OWN split, and resizing one leaves the others alone', async () => {
  launched = await launchApp()
  const { page } = launched
  await createProject(page, makeScratchRepo())
  await page.reload()
  await page.waitForSelector('.app')

  await startSession(page, 'session-one')
  await startSession(page, 'session-two')

  // session-two: drag the conversation narrower
  await openFiles(page)
  const twoBefore = await chatWidth(page)
  await dragDivider(page, '.tile .resize-handle-v', -220)
  const twoDragged = await chatWidth(page)
  expect(Math.abs(twoDragged - twoBefore)).toBeGreaterThan(80)

  // session-one must be untouched by that drag
  await page.locator('.session-row', { hasText: 'session-one' }).click()
  await openFiles(page)
  const oneWidth = await chatWidth(page)
  expect(Math.abs(oneWidth - twoDragged)).toBeGreaterThan(80)

  // and session-two still has its own
  await page.locator('.session-row', { hasText: 'session-two' }).click()
  await openFiles(page)
  expect(Math.abs((await chatWidth(page)) - twoDragged)).toBeLessThan(24)

  // back to one: still its own, not two's
  await page.locator('.session-row', { hasText: 'session-one' }).click()
  await openFiles(page)
  expect(Math.abs((await chatWidth(page)) - oneWidth)).toBeLessThan(24)
})
