import { test, expect } from '@playwright/test'
import { basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Cursor/iTerm2-style side-by-side terminals: drag a terminal list row onto
 * the visible terminal area to split it (resizable, react-resizable-panels),
 * with a plain split button as the non-dnd alternative. Cap is 2 visible
 * terminals at once. See TerminalPanel.tsx.
 */
test.describe('terminal split', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('drag a list row onto the visible terminal to split side by side, persists across tab switch', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    // pin bash so prompt text is deterministic (see terminal-keymap.spec.ts)
    await page.evaluate(() => window.hang4r.setSetting('terminalShell', '/bin/bash'))
    await expect(page.locator('.project-name')).toHaveText(basename(repo))
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('term split test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-panel')).toBeVisible()

    const firstTerm = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(firstTerm.locator('.xterm')).toBeVisible({ timeout: 15_000 })
    await expect(firstTerm).toContainText('bash-3.2$', { timeout: 10_000 })

    // add a second terminal via '+' — it becomes active/visible (new tab gets
    // focus, like a fresh browser tab); the FIRST terminal's row is now the
    // background one to drag back into view alongside it.
    await tile.locator('.terminal-list-actions .ghost-btn').first().click()
    await expect(tile.locator('.terminal-list-row')).toHaveCount(2)
    const firstRow = tile.locator('.terminal-list-row').nth(0)

    // Drag the first row onto the RIGHT half of the visible terminal area.
    // HTML5 native DnD isn't driven by real mouse events in Playwright here,
    // so this dispatches dragstart/dragover/drop with a shared DataTransfer —
    // same technique as the workspace-reorder and file-drag-to-composer e2e
    // tests in session-flow.spec.ts.
    const stack = tile.locator('.terminal-stack')
    const stackBox = await stack.boundingBox()
    if (!stackBox) throw new Error('no stack box')
    const rightX = stackBox.x + stackBox.width * 0.9
    const midY = stackBox.y + stackBox.height * 0.5

    const dt = await page.evaluateHandle(() => new DataTransfer())
    await firstRow.dispatchEvent('dragstart', { dataTransfer: dt })
    await stack.dispatchEvent('dragover', { dataTransfer: dt, clientX: rightX, clientY: midY })
    // translucent edge overlay shows the drop target while dragging
    await expect(tile.locator('.pane-drop-overlay.pane-drop-right')).toBeVisible()
    await stack.dispatchEvent('drop', { dataTransfer: dt, clientX: rightX, clientY: midY })

    await expect(tile.locator('.terminal-stack-split')).toBeVisible()
    const visibleTerms = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(visibleTerms).toHaveCount(2)
    // resizable split handle between the two panes
    await expect(tile.locator('.terminal-stack .resize-handle')).toBeVisible()

    // typing into the right pane lands only there, not the left one
    const rightTerm = visibleTerms.nth(1)
    const leftTerm = visibleTerms.nth(0)
    await rightTerm.click()
    await page.keyboard.type('echo RIGHT_PANE_MARKER\n')
    await expect(rightTerm).toContainText('RIGHT_PANE_MARKER', { timeout: 10_000 })
    await expect(leftTerm).not.toContainText('RIGHT_PANE_MARKER')

    // switch tabs away and back — the split arrangement survives
    await tile.getByRole('button', { name: 'Files' }).click()
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-stack-split')).toBeVisible()
    const visibleAfter = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(visibleAfter).toHaveCount(2)
    await expect(visibleAfter.nth(1)).toContainText('RIGHT_PANE_MARKER')
  })

  test('dragging the ACTIVE terminal row to an edge splits it with a fresh terminal', async () => {
    // Regression pin for the round-10 "cannot side/down panel" report: the drop
    // handler used to bail when draggedId === active, so dragging the terminal
    // you're looking at (always active; the ONLY row with a single terminal —
    // the common case) silently did nothing. It must now split against a new
    // terminal. This is provable via synthetic dispatch because it exercises the
    // drop-handler LOGIC; native HTML5 drag *initiation* by a real mouse is a
    // separate dimension Playwright can't drive here (see helpers.dragTo) and
    // remains manually verified — the drag source is byte-identical to the
    // working workspace tile-header drag.
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-name')).toHaveText(basename(repo))
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('term active-drag test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-panel')).toBeVisible()
    await expect(tile.locator('.terminal-slot:visible .xterm')).toBeVisible({ timeout: 15_000 })

    // exactly ONE terminal — its row is the active one
    await expect(tile.locator('.terminal-list-row')).toHaveCount(1)
    const onlyRow = tile.locator('.terminal-list-row').nth(0)
    await expect(onlyRow).toHaveClass(/terminal-list-row-active/)

    const stack = tile.locator('.terminal-stack')
    const stackBox = await stack.boundingBox()
    if (!stackBox) throw new Error('no stack box')
    const bottomX = stackBox.x + stackBox.width * 0.5
    const bottomY = stackBox.y + stackBox.height * 0.9

    const dt = await page.evaluateHandle(() => new DataTransfer())
    await onlyRow.dispatchEvent('dragstart', { dataTransfer: dt })
    await stack.dispatchEvent('dragover', { dataTransfer: dt, clientX: bottomX, clientY: bottomY })
    await expect(tile.locator('.pane-drop-overlay.pane-drop-bottom')).toBeVisible()
    await stack.dispatchEvent('drop', { dataTransfer: dt, clientX: bottomX, clientY: bottomY })

    // a fresh terminal appeared and a STACKED split is now visible
    await expect(tile.locator('.terminal-list-row')).toHaveCount(2)
    await expect(tile.locator('.terminal-stack-split-bottom')).toBeVisible()
    await expect(tile.locator('.terminal-slot:visible .terminal-view')).toHaveCount(2)
  })

  test('the terminal list is resizable and its width persists across a tab switch', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-name')).toHaveText(basename(repo))
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('term resize test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-panel')).toBeVisible()

    const list = tile.locator('.terminal-list-panel')
    const before = (await list.boundingBox())!.width
    // the list separator (the only resize handle when unsplit) — drag it right
    const handle = tile.locator('.terminal-panel-group > [data-separator]')
    const hb = (await handle.boundingBox())!
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + 90, hb.y + hb.height / 2, { steps: 8 })
    await page.mouse.up()

    const after = (await list.boundingBox())!.width
    expect(after).toBeGreaterThan(before + 40)

    // leave the Terminal tab and come back — the panel unmounts, so this proves
    // the module-memo persistence (listWidthMemo) restores the custom width
    await tile.getByRole('button', { name: 'Files' }).click()
    await expect(tile.locator('.terminal-panel')).toBeHidden()
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-panel')).toBeVisible()
    const restored = (await tile.locator('.terminal-list-panel').boundingBox())!.width
    expect(Math.abs(restored - after)).toBeLessThan(24)
  })

  test('split button creates a side-by-side split with a new terminal', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-name')).toHaveText(basename(repo))
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('term split button test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-panel')).toBeVisible()
    await expect(tile.locator('.terminal-slot:visible .xterm')).toBeVisible({ timeout: 15_000 })

    await tile.locator('.terminal-list-actions .ghost-btn[title^="Split terminal right"]').click()
    await expect(tile.locator('.terminal-list-row')).toHaveCount(2)
    await expect(tile.locator('.terminal-stack-split')).toBeVisible()
    await expect(tile.locator('.terminal-slot:visible .terminal-view')).toHaveCount(2)
  })
})
