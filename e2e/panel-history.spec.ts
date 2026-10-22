import { writeFileSync } from 'node:fs'
import { test, expect, type Page, type Locator } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The Subagents and Tasks panels used to derive only from the transcript window
 * (the last `openTurns` turns), so everything launched earlier vanished once a
 * session grew past it. They now also read the top-level launches/results the
 * window left behind (getPanelHistory) and fetch an old run's thread on expand
 * (getSubagentEvents). The bug only shows on LOAD, so each test reopens the
 * session through the windowed loader instead of reading live state.
 *
 * The fake agent already emits, every turn N: an Agent "explore for turn N"
 * (with an inner text block), a background Bash (id bgN) and a TaskCreate
 * "fake task for turn N". Turn 1 also carries 'background agent still working'
 * for an Agent "long errand" whose inner thread holds a Read tool row.
 */
const WINDOW = 2
const TURNS = 5

test.describe('panels read past the transcript window', () => {
  let launched: LaunchedApp | undefined
  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  /** A session of TURNS turns, then reopened so only the last WINDOW are loaded. */
  async function windowedSession(
    hold = false
  ): Promise<{ page: Page; tile: Locator; sid: string }> {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await page.evaluate((n) => window.hang4r.setSetting('openTurns', String(n)), WINDOW)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await page
      .locator('.dialog-prompt')
      .fill(
        'turn 1 background agent still working subagent bg bash' + (hold ? ' hold bg open' : '')
      )
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    const sid = (await page.evaluate(() => window.hang4r.listSessions()))[0].id
    for (let n = 2; n <= TURNS; n++) {
      await page.evaluate(([id, t]) => window.hang4r.prompt(id as string, `turn ${t}`), [sid, n])
      await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    }

    // reopen: the transcript now comes through the windowed loader
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.session-row').first().click()
    await expect(tile.locator('.chat-load-earlier')).toBeVisible({ timeout: 20_000 })
    return { page, tile, sid }
  }

  async function openTab(tile: Locator, name: 'Subagents' | 'Tasks'): Promise<void> {
    const view = tile.locator(name === 'Subagents' ? '.subagents-view' : '.bgtasks-view')
    // the active tab persists across a reload; clicking it again would close it
    if ((await view.count()) === 0) await tile.getByRole('button', { name, exact: true }).click()
    await expect(view).toBeVisible({ timeout: 10_000 })
  }

  const run = (tile: Locator, label: string): Locator =>
    tile
      .locator('.subagent-run')
      .filter({ has: tile.page().locator('.subagent-label', { hasText: label }) })

  test('an agent launched before the window is still listed', async () => {
    const { page, tile, sid } = await windowedSession()

    // premise: the window really excludes turn 1 (so a window-only panel could not list it)
    const win = await page.evaluate(
      ([id, n]) => window.hang4r.getRecentSessionEvents(id as string, n as number),
      [sid, WINDOW]
    )
    expect(win.truncated).toBe(true)
    const windowLabels = win.events
      .filter(
        (e) =>
          e.event.kind === 'block-final' &&
          e.event.block?.type === 'tool_use' &&
          e.event.block.name === 'Agent'
      )
      .map((e) => e.event.block.input.description)
    expect(windowLabels).not.toContain('explore for turn 1')
    expect(windowLabels).not.toContain('long errand')

    await openTab(tile, 'Subagents')
    await expect(run(tile, 'explore for turn 5')).toHaveCount(1, { timeout: 15_000 })
    await expect(run(tile, 'explore for turn 1')).toHaveCount(1, { timeout: 15_000 })
    await expect(run(tile, 'explore for turn 2')).toHaveCount(1)
    await expect(run(tile, 'long errand')).toHaveCount(1)
    // 5 explore runs + the turn-1 long errand: nothing dropped, nothing doubled
    await expect(tile.locator('.subagent-run')).toHaveCount(TURNS + 1)
  })

  test('expanding an old run loads its thread body', async () => {
    const { tile } = await windowedSession()
    await openTab(tile, 'Subagents')

    const errand = run(tile, 'long errand')
    await expect(errand).toHaveCount(1, { timeout: 15_000 })
    // older runs start collapsed: no body, no inner rows yet
    await expect(errand.locator('.subagent-run-body')).toHaveCount(0)

    await errand.locator('.subagent-run-header').click()
    await expect(errand.locator('.subagent-run-body')).toBeVisible()
    await expect(errand.locator('.subagent-text')).toContainText('Let me read the sources', {
      timeout: 10_000
    })
    await expect(errand.locator('.subagent-tool-row')).toHaveCount(1)
    await expect(errand.locator('.subagent-tool')).toContainText('Read')
    await expect(errand.locator('.subagent-empty')).toHaveCount(0)

    const explore = run(tile, 'explore for turn 1')
    await explore.locator('.subagent-run-header').click()
    await expect(explore.locator('.subagent-text')).toContainText(
      'Subagent scanned the repo (turn 1)',
      { timeout: 10_000 }
    )
  })

  test('Load earlier turns lists each run exactly once', async () => {
    const { tile } = await windowedSession()
    await openTab(tile, 'Subagents')
    await expect(run(tile, 'explore for turn 1')).toHaveCount(1, { timeout: 15_000 })
    const before = await tile.locator('.subagent-run').count()
    expect(before).toBe(TURNS + 1)

    // expand an old thread first, so a double-applied thread would show up as doubled blocks
    const errand = run(tile, 'long errand')
    await errand.locator('.subagent-run-header').click()
    await expect(errand.locator('.subagent-tool-row')).toHaveCount(1, { timeout: 10_000 })

    await tile.locator('.chat-load-earlier').click()
    await expect(tile.locator('.chat-load-earlier')).toBeHidden({ timeout: 20_000 })

    // history and window now overlap completely; settle, then count
    await expect(run(tile, 'explore for turn 1')).toHaveCount(1)
    for (let n = 1; n <= TURNS; n++) await expect(run(tile, `explore for turn ${n}`)).toHaveCount(1)
    await expect(run(tile, 'long errand')).toHaveCount(1)
    await expect(tile.locator('.subagent-run')).toHaveCount(before)
    await expect(errand.locator('.subagent-tool-row')).toHaveCount(1)
  })

  test('the Tasks panel keeps an early background task and todo', async () => {
    const { tile } = await windowedSession()
    await openTab(tile, 'Tasks')

    // TaskCreate "fake task for turn N" and background bash id bgN, per turn
    await expect(tile.locator('.todo-subject', { hasText: 'fake task for turn 5' })).toHaveCount(
      1,
      { timeout: 15_000 }
    )
    await expect(tile.locator('.todo-subject', { hasText: 'fake task for turn 1' })).toHaveCount(
      1,
      { timeout: 15_000 }
    )
    await expect(tile.locator('.bgtask-id', { hasText: /^\s*bg1\s*$/ })).toHaveCount(1)
    await expect(tile.locator('.bgtask-id', { hasText: /^\s*bg5\s*$/ })).toHaveCount(1)
    // (the fake also launches a Workflow every turn, so count the bash cards only)
    const bash = tile
      .locator('.bgtask')
      .filter({ has: tile.page().locator('.bgtask-kind', { hasText: 'bash' }) })
    await expect(bash).toHaveCount(TURNS + 1) // five turns' dev servers + the subagent's watcher
    for (let n = 1; n <= TURNS; n++) {
      await expect(
        tile.locator('.bgtask-id', { hasText: new RegExp(`^\\s*bg${n}\\s*$`) })
      ).toHaveCount(1)
    }

    // History contract. A workflow older than the window is always 'ended'. An old
    // bash task reads what ONE batched probe of its output file says: the fake's
    // log carries no terminal marker and nothing holds it open (no lsof writer),
    // so resolveBackgroundTaskState answers 'done' for it.
    const card = (id: string | RegExp): Locator =>
      tile.locator('.bgtask').filter({ has: tile.page().locator('.bgtask-id', { hasText: id }) })
    for (const n of [1, 2, 3]) {
      await expect(card(`wf_${n}abcdef`).locator('.bgtask-status')).toHaveText('ended')
    }
    for (const n of [1, 2, 3]) {
      await expect(card(new RegExp(`^\\s*bg${n}\\s*$`)).locator('.bgtask-status')).toHaveText(
        'done',
        { timeout: 10_000 }
      )
    }

    // the window's own workflows (turns 4-5) are still live-looking; dismiss those
    // two cards, then NOTHING may read running, so history cannot be what lights
    // "Stop turn" (or any running dot)
    for (const n of [4, 5]) await card(`wf_${n}abcdef`).locator('.bgtask-dismiss').click()
    await expect(tile.locator('.bgtask')).toHaveCount(TURNS * 2 - 2 + 1) // +1: the subagent's own bg task
    await expect(tile.locator('.bgtask-status-running')).toHaveCount(0)
    await expect(tile.getByRole('button', { name: /Stop turn/ })).toHaveCount(0)

    // and Load earlier changes none of it
    await tile.locator('.chat-load-earlier').click()
    await expect(tile.locator('.chat-load-earlier')).toBeHidden({ timeout: 20_000 })
    await expect(bash).toHaveCount(TURNS + 1)
    // (once loaded into the transcript proper an old Workflow reads like any other
    // loaded one - 'running', the collector's reading - so only identity and
    // the bash poll's verdict are asserted here)
    await expect(card('wf_1abcdef')).toHaveCount(1)
    await expect(card(/^\s*bg1\s*$/)).toHaveCount(1)
    await expect(card(/^\s*sub1\s*$/)).toHaveCount(1)
    await expect(card(/^\s*bg1\s*$/).locator('.bgtask-status')).toHaveText('done', {
      timeout: 10_000
    })
    await expect(tile.locator('.todo-subject', { hasText: 'fake task for turn 1' })).toHaveCount(1)
  })

  test('history tasks do not light the pending-work indicator', async () => {
    const { tile } = await windowedSession()
    const waiting = tile.locator('.turn-info-waiting')
    const runs = tile.locator('.composer-runs')
    const before = { w: await waiting.allInnerTexts(), r: await runs.count() }

    await openTab(tile, 'Tasks')
    await expect(tile.locator('.bgtask-id', { hasText: /^\s*bg1\s*$/ })).toHaveCount(1, {
      timeout: 15_000
    })
    await expect(
      tile
        .locator('.bgtask')
        .filter({ has: tile.page().locator('.bgtask-id', { hasText: /^\s*bg1\s*$/ }) })
        .locator('.bgtask-status')
    ).toHaveText('done', { timeout: 10_000 })
    await openTab(tile, 'Subagents')
    await expect(run(tile, 'explore for turn 1')).toHaveCount(1, { timeout: 15_000 })

    // identical to what the window alone produced before any history was fetched
    expect({ w: await waiting.allInnerTexts(), r: await runs.count() }).toEqual(before)
  })

  test('Expand all leaves history runs closed', async () => {
    const { tile } = await windowedSession()
    await openTab(tile, 'Subagents')
    await expect(run(tile, 'explore for turn 1')).toHaveCount(1, { timeout: 15_000 })

    const toggle = tile.locator('.subagents-collapse-all')
    // window runs start open, so the control offers Collapse; cycle it to Expand all
    await expect(toggle).toHaveText('Collapse all')
    await toggle.click()
    await expect(toggle).toHaveText('Expand all')
    await toggle.click()
    await expect(toggle).toHaveText('Collapse all')

    await expect(run(tile, 'explore for turn 5').locator('.subagent-run-body')).toHaveCount(1)
    await expect(run(tile, 'explore for turn 4').locator('.subagent-run-body')).toHaveCount(1)
    for (const l of [
      'explore for turn 1',
      'explore for turn 2',
      'explore for turn 3',
      'long errand'
    ]) {
      await expect(run(tile, l).locator('.subagent-run-body')).toHaveCount(0)
    }
  })

  test('a subagent-launched background command appears once in Tasks and once in its thread', async () => {
    const { tile } = await windowedSession()
    await openTab(tile, 'Tasks')
    const sub = tile.locator('.bgtask-id', { hasText: /^\s*sub1\s*$/ })
    await expect(sub).toHaveCount(1, { timeout: 15_000 })
    await expect(tile.locator('.bgtask-cmd', { hasText: 'subagent watcher' })).toHaveCount(1)

    await openTab(tile, 'Subagents')
    const explore = run(tile, 'explore for turn 1')
    await explore.locator('.subagent-run-header').click()
    await expect(explore.locator('.subagent-text')).toContainText(
      'Subagent scanned the repo (turn 1)',
      { timeout: 10_000 }
    )
    await expect(explore.locator('.subagent-tool-row')).toHaveCount(1)
    await expect(explore.locator('.subagent-tool')).toContainText('Bash')

    // the thread merging into the Subagents panel must not duplicate the Tasks card
    await openTab(tile, 'Tasks')
    await expect(tile.locator('.bgtask-id', { hasText: /^\s*sub1\s*$/ })).toHaveCount(1)
  })

  test('a history task whose process is live shows running, then flips to done and stays', async () => {
    const { page, tile, sid } = await windowedSession(true)
    const log =
      (await page.evaluate(
        (id) => window.hang4r.listSessions().then((l) => l.find((x) => x.id === id)!.cwd),
        sid
      )) + '/.hang4r-bg-1.log'
    // never leak the holder process, even if an assertion below throws
    try {
      const bg1 = (): Locator =>
        tile
          .locator('.bgtask')
          .filter({ has: tile.page().locator('.bgtask-id', { hasText: /^\s*bg1\s*$/ }) })
      const bg2 = (): Locator =>
        tile
          .locator('.bgtask')
          .filter({ has: tile.page().locator('.bgtask-id', { hasText: /^\s*bg2\s*$/ }) })

      await openTab(tile, 'Tasks')
      // the probe saw a live writer on bg1's log (and none on bg2's)
      await expect(bg1().locator('.bgtask-status')).toHaveText('running', { timeout: 10_000 })
      await expect(bg2().locator('.bgtask-status')).toHaveText('done', { timeout: 10_000 })

      // the process exits: the 2 s poll writes the terminal state back
      writeFileSync(log + '.stop', '')
      await expect(bg1().locator('.bgtask-status')).toHaveText('done', { timeout: 10_000 })

      // and it stays done after leaving the tab and coming back
      await openTab(tile, 'Subagents')
      await expect(tile.locator('.bgtasks-view')).toHaveCount(0)
      await openTab(tile, 'Tasks')
      await expect(bg1().locator('.bgtask-status')).toHaveText('done')
      await page.waitForTimeout(3000)
      await expect(bg1().locator('.bgtask-status')).toHaveText('done')
    } finally {
      writeFileSync(log + '.stop', '')
    }
  })
})
