import { test, expect } from '@playwright/test'
import { basename, join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { launchApp, makeScratchRepo, createProject, dragTo, type LaunchedApp } from './helpers'

/**
 * Full-pipeline verification, driven through the real UI with the deterministic
 * fake agent. Proves the app "runs and does what it's supposed to":
 * project → session → streamed events → diff → inline comment → review.
 */
test.describe('agent session flow', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  test('boots to the empty state', async () => {
    launched = await launchApp()
    await expect(launched.page.locator('.workspace-empty h1')).toHaveText('hang4r')
    await expect(launched.page.locator('.app-title')).toHaveText('hang4r')
  })

  test('creates a session, streams a turn, and shows the diff + review', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()

    // Bypass the native folder picker via the exposed IPC, then reload so the
    // store re-fetches projects.
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.project-name')).toHaveText(basename(repo))

    // Open the new-session dialog and start an agent.
    await page.locator('.project-row .ghost-btn').first().click()
    await expect(page.locator('.dialog')).toBeVisible()
    await page.locator('.dialog-prompt').fill('Please make an edit')
    await page.getByRole('button', { name: /Start agent/ }).click()

    // The session tile appears and streams the fake agent's reply.
    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    // A new agent opens CHAT-ONLY (Cursor): the conversation is all that shows —
    // no context panel until you open one (verified side-by-side at Subagents below).
    await expect(tile.locator('.chat-panel')).toBeVisible()
    await expect(tile.locator('.context-panel')).toHaveCount(0)
    await expect(tile.locator('.msg-user-card')).toContainText('Please make an edit')
    await expect(tile.locator('.msg-assistant').first()).toContainText('turn 1')
    await expect(tile.locator('.tool-name', { hasText: 'Write' })).toBeVisible()

    // Session settles to idle after the turn completes.
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Subagents tab: opening a context panel renders it SIDE-BY-SIDE with chat
    // (resizable split), and the Task subagent run is captured and inspectable.
    await tile.getByRole('button', { name: 'Subagents' }).click()
    await expect(tile.locator('.context-panel')).toBeVisible()
    await expect(tile.locator('.tile-body .resize-handle').first()).toBeVisible()
    const run = tile.locator('.subagent-run').first()
    await expect(run).toBeVisible()
    await expect(run.locator('.subagent-type')).toContainText('Explore')
    await expect(run.locator('.subagent-status-done')).toBeVisible()
    await expect(run.locator('.subagent-run-body')).toContainText('found 2 matches')

    // Switch to the Diff tab; the fake agent wrote a real file into the worktree.
    await tile.getByRole('button', { name: 'Diff' }).click()
    await tile.locator('.diff-files-header [title="Refresh"]').click()
    // Worktrees default to Branch Commits (PR content); the per-hunk Revert/Stage
    // and inline-comment steps below live on the working-tree-vs-base scope, so
    // switch to "All Changes" first.
    await tile.locator('.diff-scope-btn').click()
    await tile.locator('.diff-scope-menu').getByRole('button', { name: /All Changes/ }).click()
    // review actions toolbar is present (Commit / PR always; Merge for worktrees)
    await expect(tile.locator('.diff-actions button', { hasText: 'Commit' })).toBeVisible()
    await expect(tile.locator('.diff-actions button', { hasText: 'PR' })).toBeVisible()
    const fileRow = tile.locator('.diff-file-row', { hasText: 'hang4r-fake-1.txt' })
    await expect(fileRow).toBeVisible({ timeout: 15_000 })
    await fileRow.click()

    // Diff toolbar (image 41): ⋯ menu toggles Split layout + options; per-hunk
    // Stage/Revert actions exist in the hunk header.
    await expect(tile.locator('.diff-toolbar')).toBeVisible()
    await expect(tile.locator('.diff-hunk-head .diff-hunk-btn', { hasText: 'Revert' }).first()).toHaveCount(1)
    await tile.locator('.diff-toolbar-btn').click()
    await expect(tile.locator('.diff-menu')).toBeVisible()
    await expect(tile.locator('.diff-menu button', { hasText: 'Ignore whitespace' })).toBeVisible()
    await tile.locator('.diff-menu button', { hasText: 'Split' }).click()
    await expect(tile.locator('.diff-row-split').first()).toBeVisible({ timeout: 10_000 })
    // back to unified for the inline-comment steps below
    await tile.locator('.diff-toolbar-btn').click()
    await tile.locator('.diff-menu button', { hasText: 'Unified' }).click()

    // Add an inline comment via the inline composer (no window.prompt — Electron
    // doesn't implement it). The affordance reveals on row hover (GitHub-style).
    await fileRow.click()
    const diffRow = tile.locator('.diff-row-add').first()
    await expect(diffRow).toBeVisible({ timeout: 15_000 })
    await diffRow.hover()
    await diffRow.locator('.diff-comment-btn').click()
    const composer = tile.locator('.comment-composer-input')
    await composer.fill('please tweak this line')
    await expect(composer).toHaveValue('please tweak this line')
    await tile.getByRole('button', { name: 'Add comment' }).click()
    await expect(tile.locator('.diff-comment-cell')).toContainText('please tweak this line')

    // The review bar appears; sending it posts a follow-up user turn.
    await expect(tile.locator('.review-bar')).toBeVisible()
    await tile.getByRole('button', { name: /Send review/ }).click()
    await expect(tile.locator('.msg-user-card')).toHaveCount(2)
    await expect(tile.locator('.msg-assistant').last()).toContainText('turn 2')

    // Terminal tab: a real PTY spawns in the session cwd and *executes* commands.
    // Assert on computed output (44) that cannot come from the echoed keystrokes.
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-panel')).toBeVisible()
    await expect(tile.locator('.terminal-list-row')).toHaveCount(1)
    const activeTerm = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(activeTerm.locator('.xterm')).toBeVisible({ timeout: 15_000 })
    await activeTerm.click()
    await page.keyboard.type('echo RESULT=$((22+22))\n')
    await expect(activeTerm).toContainText('RESULT=44', { timeout: 15_000 })
    // add a second terminal
    await tile.locator('.terminal-list-head .ghost-btn', { hasText: '+' }).click()
    await expect(tile.locator('.terminal-list-row')).toHaveCount(2)

    // Files panel: tree toolbar (new file) + edit a file in Monaco.
    await tile.getByRole('button', { name: 'Files' }).click()
    await tile.locator('.files-tree-toolbar [title="New file"]').click()
    await expect(page.locator('.input-dialog')).toBeVisible()
    await page.locator('.input-dialog .field').fill('hang4r-toolbar-new.txt')
    await page.locator('.input-dialog').getByRole('button', { name: 'OK' }).click()
    await expect(tile.locator('.editor-tab', { hasText: 'hang4r-toolbar-new.txt' })).toBeVisible({ timeout: 15_000 })
    await expect(tile.locator('.file-row', { hasText: 'hang4r-toolbar-new.txt' })).toBeVisible()
    const readmeRow = tile.locator('.file-row', { hasText: 'README.md' })
    await expect(readmeRow).toBeVisible({ timeout: 15_000 })
    await readmeRow.click()
    await expect(tile.locator('.editor-slot:visible .code-editor-path')).toContainText('README.md')
    // open more files → tabs coexist (new-file tab + README + index.js = 3)
    await tile.locator('.file-row', { hasText: 'src' }).click()
    await tile.locator('.file-row', { hasText: 'index.js' }).click()
    await expect(tile.locator('.editor-tab')).toHaveCount(3)
    await tile.locator('.editor-tab', { hasText: 'README.md' }).click()
    // active editor = the visible slot
    const activeEditor = tile.locator('.editor-slot:visible')
    await expect(activeEditor.locator('.view-lines')).toContainText('scratch', { timeout: 15_000 })

    // Type into the editor and Save; assert it persisted to disk via IPC.
    await activeEditor.locator('.monaco-editor').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' EDITED_BY_HANG4R')
    await expect(activeEditor.locator('.code-editor-save')).toBeEnabled()
    await activeEditor.locator('.code-editor-save').click()
    await expect(activeEditor.locator('.code-editor-save')).toBeDisabled() // saved
    // Force a fresh read from disk: switch tabs away and back (index.js tab is open).
    await tile.locator('.editor-tab', { hasText: 'index.js' }).click()
    await tile.locator('.editor-tab', { hasText: 'README.md' }).click()
    await expect(tile.locator('.editor-slot:visible .view-lines')).toContainText(
      'EDITED_BY_HANG4R',
      { timeout: 10_000 }
    )

    // ---- Git source control in the explorer ----
    // The saved README edit is an uncommitted change → shows an 'M' badge.
    await tile.locator('.files-tree-toolbar [title="Refresh"]').click()
    const readmeGit = tile.locator('.file-row', { hasText: 'README.md' }).first()
    await expect(readmeGit.locator('.git-badge')).toHaveText('M', { timeout: 10_000 })
    // Stage it via the hover '+' action; the row stays a tracked change.
    await readmeGit.hover()
    await readmeGit.locator('.git-act[title="Stage"]').click()
    await expect(
      tile.locator('.file-row', { hasText: 'README.md' }).first().locator('.git-badge')
    ).toBeVisible({ timeout: 10_000 })
    // 'Open Changes' from the right-click menu → switches to the Diff tab.
    await tile.locator('.file-row', { hasText: 'README.md' }).first().click({ button: 'right' })
    await page.locator('.ctx-item', { hasText: 'Open Changes' }).click()
    await expect(tile.locator('.diff-file-row', { hasText: 'README.md' })).toBeVisible({
      timeout: 10_000
    })
    // back to Files for the remaining steps
    await tile.getByRole('button', { name: 'Files' }).click()

    // Cmd-click a relative import → opens the target file in a new tab.
    // (the Refresh above remounts+collapses the tree, so re-expand src)
    await tile.locator('.file-row', { hasText: 'src' }).click()
    await tile.locator('.file-row', { hasText: 'app.js' }).click()
    await expect(tile.locator('.editor-slot:visible .code-editor-path')).toContainText('app.js')
    const importTok = tile.locator('.editor-slot:visible .view-line', { hasText: './index.js' }).first()
    await importTok.getByText('index', { exact: false }).first().click({ modifiers: ['Meta'] })
    await expect(tile.locator('.editor-tab', { hasText: 'index.js' })).toBeVisible({ timeout: 10_000 })

    // Browser tab renders its toolbar (webview loads only on user-entered URL).
    await tile.getByRole('button', { name: 'Browser' }).click()
    await expect(tile.locator('.browser-url')).toBeVisible()

    // ---- Panes: a second session opens SINGLE, then drag-to-split ----
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('Second parallel agent')
    await page.getByRole('button', { name: /Start agent/ }).click()
    // new Cursor behavior: creating a 2nd session does NOT auto-split — it takes
    // over the workspace as a single pane (both sessions still listed sidebar-side)
    await expect(page.locator('.pane')).toHaveCount(1)
    await expect(page.locator('.session-row')).toHaveCount(2)
    // side-by-side is explicit: drag the OTHER (non-focused) session from the
    // sidebar onto the right half of the open pane → it splits in after it
    await dragTo(page, '.session-row:not(.session-row-focused)', '.pane', 'right')
    await expect(page.locator('.pane')).toHaveCount(2)
    expect(await page.locator('.resize-handle').count()).toBeGreaterThanOrEqual(1)
    await expect(page.locator('.session-row')).toHaveCount(2)

    // rename via double-click on the second tile's title
    const tile2 = page.locator('.pane').nth(1).locator('.tile')
    await tile2.locator('.tile-title').dblclick()
    await tile2.locator('.tile-title-input').fill('Renamed agent')
    await tile2.locator('.tile-title-input').press('Enter')
    await expect(tile2.locator('.tile-title')).toHaveText('Renamed agent')
    await expect(page.locator('.session-row', { hasText: 'Renamed agent' })).toBeVisible()

    // inline permission card: agent asks, user clicks Allow, turn resolves
    await expect(tile2.locator('.status-dot.status-idle')).toBeVisible({ timeout: 15_000 })
    await tile2.locator('.composer-input').fill('please ask permission before proceeding')
    await tile2.getByRole('button', { name: 'Send' }).click()
    const permCard = tile2.locator('.permission-card')
    await expect(permCard).toBeVisible()
    await expect(permCard).toContainText('rm -rf')
    // exact: the card now also offers "Allow for session" / "Always allow"
    await permCard.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(permCard.locator('.permission-decision')).toContainText('allow')

    // ---- Best of N: same prompt across 2 variants, each its own worktree pane ----
    await page.locator('.project-row .ghost-btn').first().click()
    await page.getByRole('button', { name: 'Best of N' }).click()
    await page.locator('.variant-chip', { hasText: 'Claude Sonnet' }).click()
    await page.locator('.variant-chip', { hasText: 'Claude Haiku' }).click()
    await page.locator('.dialog-prompt').fill('Compare approaches')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.pane')).toHaveCount(4, { timeout: 20_000 })
    await expect(page.locator('.session-row')).toHaveCount(4)
    await expect(page.locator('.session-row', { hasText: '[claude/sonnet]' })).toBeVisible()

    // sidebar session search filters the list
    await page.locator('.session-search').fill('sonnet')
    await expect(page.locator('.session-row')).toHaveCount(1)
    await page.locator('.session-search').fill('')
    await expect(page.locator('.session-row').first()).toBeVisible()

    // ---- Command palette (⌘K), context menu, settings ----
    await page.keyboard.press('Meta+k')
    await expect(page.locator('.palette')).toBeVisible()
    await page.locator('.palette-input').fill('settings')
    await expect(page.locator('.palette-item', { hasText: 'Settings' }).first()).toBeVisible()
    await page.locator('.palette-input').press('Enter')
    await expect(page.locator('.settings-page')).toBeVisible()
    // categorized nav: General default, switch to Keyboard to see shortcuts, Models for paths
    await page.locator('.settings-nav-item', { hasText: 'Models' }).click()
    await expect(page.locator('.settings-content')).toContainText('binary path')
    await page.locator('.settings-nav-item', { hasText: 'Keyboard' }).click()
    await expect(page.locator('.shortcut-grid')).toContainText('Command palette')
    await page.locator('.settings-header').getByRole('button', { name: '✕' }).click()

    // ⌘P quick file finder → open README.md into the focused session's tile.
    // (scoped to .tile-focused, not page-wide: tile1's own README.md tab from
    // way back at line 131 now legitimately survives every re-split since —
    // that's the fix under test in the "layout survives" case above — so a
    // page-wide locator would see two matches.)
    await page.keyboard.press('Meta+p')
    await expect(page.locator('.palette-input')).toBeVisible()
    await page.locator('.palette-input').fill('readme')
    await expect(page.locator('.finder-item').first()).toContainText('README')
    await page.locator('.palette-input').press('Enter')
    await expect(
      page.locator('.tile.tile-focused .editor-tab', { hasText: 'README.md' })
    ).toBeVisible({ timeout: 15_000 })

    // right-click a session row → context menu with lifecycle actions
    await page.locator('.session-row').first().click({ button: 'right' })
    await expect(page.locator('.ctx-menu')).toBeVisible()
    await expect(page.locator('.ctx-item', { hasText: 'Duplicate' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.ctx-menu')).toBeHidden()

    // Composer @-attach: + button opens the attach menu, pick a file → context chip.
    await tile.locator('.composer-attach').click()
    await expect(tile.locator('.attach-menu')).toBeVisible()
    await tile.locator('.attach-input').fill('readme')
    await tile.locator('.attach-item', { hasText: 'README.md' }).first().click()
    await expect(tile.locator('.context-chip', { hasText: 'README.md' })).toBeVisible()
    await page.keyboard.press('Escape')

    // Per-conversation usage: tile status shows a context meter + token counts.
    await expect(tile.locator('.session-usage .usage-toks')).toContainText(/k↓/)
    await expect(tile.locator('.session-usage .ctx-meter')).toBeVisible()
    // Sidebar usage panel: REAL Claude usage header (windows load async from
    // `claude -p /usage`) plus token/spend stats. The per-session context pill
    // is deliberately hidden below 80% occupancy (noise reduction) — a fake
    // session's tiny context must NOT render one.
    // the sidebar now has one usage pane per backend — target the Claude one
    await expect(page.locator('.usage-scope', { hasText: 'Claude usage' })).toBeVisible()
    await expect(page.locator('.sidebar-usage .usage-stat').first()).toContainText('k')
    await expect(page.locator('.session-ctx-pill')).toHaveCount(0)
    // Cursor pane: always rendered (same unconditional visibility as Claude/Codex),
    // honest about having no quota windows — expand it and check its own markup.
    await expect(page.locator('.usage-scope', { hasText: 'Cursor usage' })).toBeVisible()
    await page.locator('.usage-scope', { hasText: 'Cursor usage' }).click()
    await expect(
      page.locator('.sidebar-usage', { has: page.locator('.usage-scope', { hasText: 'Cursor usage' }) })
    ).toContainText("doesn't expose quota/usage windows")

    // Usage gauges reflect the streamed rate-limit + cost/token events.
    const usage = page.locator('[data-testid="usage-bar"]')
    await expect(usage.locator('.gauge', { hasText: '5h' })).toBeVisible()
    await expect(usage.locator('.gauge', { hasText: 'cost' })).toContainText('$0.0')
    await expect(usage.locator('.gauge', { hasText: 'tokens' })).toContainText('k')

    // ---- Archive with unsaved-change warning, then restore from history ----
    const firstRow = page.locator('.session-row').first()
    const firstTitle = (await firstRow.locator('.session-title').textContent()) ?? ''
    // archive via context menu → confirm the uncommitted-changes warning
    await firstRow.click({ button: 'right' })
    await page.locator('.ctx-item', { hasText: 'Archive' }).click()
    await expect(page.locator('.dialog').filter({ hasText: 'uncommitted' })).toBeVisible()
    await page.locator('.dialog').getByRole('button', { name: 'Confirm' }).click()
    // it leaves the sidebar
    await expect(page.locator('.session-row', { hasText: firstTitle })).toHaveCount(0)
    // open the archived browser and restore it
    await page.locator('.archived-open-btn', { hasText: 'Archived sessions' }).click()
    await expect(page.locator('.archived-dialog')).toBeVisible()
    const arcRow = page.locator('.archived-row', { hasText: firstTitle }).first()
    await expect(arcRow).toBeVisible()
    await arcRow.getByRole('button', { name: 'Restore' }).click()
    await expect(page.locator('.session-row', { hasText: firstTitle })).toBeVisible()
  })

  test('commit menu commits from the composer', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('commit menu test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // The fake turn wrote a file → the composer shows a Changes pill.
    const pill = tile.locator('.changes-pill')
    await expect(pill).toBeVisible()
    await expect(pill.locator('b')).not.toHaveText('0')

    // Split-button caret opens the commit menu (body-level portal) with all four.
    await tile.locator('.commit-caret').click()
    const menu = page.locator('.commit-menu-portal')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('button', { name: 'Commit & Push', exact: true })).toBeVisible()
    await expect(menu.getByRole('button', { name: 'Commit & Create PR', exact: true })).toBeVisible()

    // Plain Commit → message prompt → commits into the worktree.
    await menu.getByRole('button', { name: 'Commit', exact: true }).click()
    await expect(page.locator('.input-dialog')).toBeVisible()
    await page.locator('.input-dialog .field').fill('hang4r test commit')
    await page.locator('.input-dialog').getByRole('button', { name: 'OK' }).click()
    await expect(tile.locator('.composer-notice')).toContainText('Committed', { timeout: 15_000 })
  })

  test('revert hunk reverts the change in the working tree', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('revert hunk test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()

    // Make an uncommitted edit (no trailing newline → the \ No newline case that
    // used to corrupt the reconstructed hunk patch).
    await tile.locator('.file-row', { hasText: 'README.md' }).click()
    await tile.locator('.editor-slot:visible .monaco-editor').click()
    await page.keyboard.press('End')
    await page.keyboard.type('\nREVERT_ME_LINE')
    await tile.locator('.editor-slot:visible .code-editor-save').click()

    // Open its diff and revert the hunk → the added line disappears. The edit is
    // uncommitted, so view it under "All Changes" (worktrees default to Branch
    // Commits, which only shows committed work).
    await tile.getByRole('button', { name: 'Diff' }).click()
    await tile.locator('.diff-files-header [title="Refresh"]').click()
    await tile.locator('.diff-scope-btn').click()
    await tile.locator('.diff-scope-menu').getByRole('button', { name: /All Changes/ }).click()
    await tile.locator('.diff-file-row', { hasText: 'README.md' }).click()
    await expect(
      tile.locator('.diff-line', { hasText: 'REVERT_ME_LINE' }).first()
    ).toBeVisible({ timeout: 10_000 })
    await tile.locator('.diff-hunk-head').first().hover()
    await tile.locator('.diff-hunk-btn', { hasText: 'Revert' }).first().click()
    await expect(tile.locator('.diff-action-msg')).toContainText('reverted', { timeout: 10_000 })
    await expect(tile.locator('.diff-line', { hasText: 'REVERT_ME_LINE' })).toHaveCount(0)
  })

  test('review scopes + all-files inline review', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('review scopes test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Reach into the session's worktree and stage differentiated changes so the
    // scopes can be told apart: a staged add, an unstaged edit, a branch commit.
    const { readdirSync, appendFileSync } = await import('node:fs')
    const wtDir = join(repo, '.hang4r-worktrees')
    const wt = join(wtDir, readdirSync(wtDir)[0])
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: wt }).toString()
    // settle the baseline: the fake agent's bg-task files can flush AFTER the
    // per-turn checkpoint commit, leaving the tree staged-dirty forever (the
    // suite's flakiest line when this polled for clean). Wait for the tree to
    // stop changing, then absorb any leftovers — equivalent to the checkpoint
    // having caught them, which is what happens when the timing goes the other way.
    let prevStatus: string | null = null
    await expect
      .poll(
        () => {
          const s = git('status', '--porcelain').trim()
          const stable = s === prevStatus
          prevStatus = s
          return stable
        },
        { timeout: 15_000, intervals: [500, 1000] }
      )
      .toBe(true)
    if (prevStatus) {
      git('add', '-A')
      git('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'settle', '--no-verify')
    }
    // 1) a branch commit (its own commit so it lands only in the Branch scope)
    writeFileSync(join(wt, 'committed.txt'), 'committed content\n')
    git('add', 'committed.txt')
    git('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'branch commit', '--no-verify')
    // 2) a staged-but-uncommitted add, and 3) an unstaged edit — left in place
    writeFileSync(join(wt, 'staged.txt'), 'staged content\n')
    git('add', 'staged.txt')
    appendFileSync(join(wt, 'README.md'), '\nUNSTAGED_EDIT\n') // unstaged, not added

    // Open the Diff panel and refresh so it re-reads the scopes.
    await tile.getByRole('button', { name: 'Diff' }).click()
    await tile.locator('.diff-files-header [title="Refresh"]').click()

    // Scope dropdown is present, defaults to Branch Commits on a worktree (the
    // PR content), and lists per-scope counts. The working-tree-vs-base scope is
    // labeled "All Changes" (NOT "Uncommitted", which would contradict git
    // status).
    const scopeBtn = tile.locator('.diff-scope-btn')
    await expect(scopeBtn).toContainText('Branch Commits')
    await scopeBtn.click()
    const scopeMenu = tile.locator('.diff-scope-menu')
    await expect(scopeMenu.getByRole('button', { name: /Staged/ })).toBeVisible()
    await expect(scopeMenu.getByRole('button', { name: /Unstaged/ })).toBeVisible()
    await expect(scopeMenu.getByRole('button', { name: /Branch Commits/ })).toBeVisible()

    // Staged scope shows the staged add and NOT the unstaged README edit.
    await scopeMenu.getByRole('button', { name: /Staged/ }).click()
    await expect(tile.locator('.diff-file-row', { hasText: 'staged.txt' })).toBeVisible()
    await expect(tile.locator('.diff-file-row', { hasText: 'README.md' })).toHaveCount(0)

    // Unstaged scope shows the README edit and NOT the staged add.
    await scopeBtn.click()
    await tile.locator('.diff-scope-menu').getByRole('button', { name: /Unstaged/ }).click()
    await expect(tile.locator('.diff-file-row', { hasText: 'README.md' })).toBeVisible()
    await expect(tile.locator('.diff-file-row', { hasText: 'staged.txt' })).toHaveCount(0)

    // Review-all toggle renders one collapsible row per file; expanding shows hunks.
    await scopeBtn.click()
    await tile.locator('.diff-scope-menu').getByRole('button', { name: /All Changes/ }).click()
    // wait for the All Changes list to load (committed.txt is only in this scope)
    await expect(tile.locator('.diff-file-row', { hasText: 'committed.txt' })).toBeVisible()
    await tile.locator('.diff-actions button', { hasText: 'Review all' }).click()
    const rows = tile.locator('.review-file')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThan(1)
    await rows.filter({ hasText: 'staged.txt' }).locator('.review-file-head').click()
    await expect(
      rows.filter({ hasText: 'staged.txt' }).locator('.diff-hunk')
    ).toBeVisible({ timeout: 10_000 })

    // The composer "Changes N" pill opens the Diff panel straight into review-all.
    await tile.locator('.diff-actions button', { hasText: 'Review all' }).click() // toggle off
    await tile.locator('.changes-pill').click()
    await expect(tile.locator('.review-all')).toBeVisible()
    await expect(tile.locator('.review-file').first()).toBeVisible()
  })

  test('@-mention inserts a file reference and attaches it', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('at mention test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Type "@READ" → inline mention menu → Enter picks README.md.
    const ta = tile.locator('.composer-input')
    await ta.click()
    await ta.pressSequentially('look at @READ', { delay: 25 })
    await expect(tile.locator('.mention-menu')).toBeVisible({ timeout: 5_000 })
    await expect(tile.locator('.mention-item', { hasText: 'README.md' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(ta).toHaveValue(/@README\.md/)
    await expect(tile.locator('.context-chip', { hasText: 'README.md' })).toBeVisible()
  })

  test('renders images + markdown preview in editor tabs', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('media test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()

    // Markdown opens as source (Monaco) by default, like VS Code.
    await tile.locator('.file-row', { hasText: 'docs.md' }).click()
    await expect(tile.locator('.editor-slot:visible .monaco-editor')).toBeVisible({ timeout: 10_000 })
    // Switch to rendered preview via the Preview | Source segmented control
    // next to Save (replaced the old per-tab eye toggle).
    await tile.locator('.preview-source-tab', { hasText: 'Preview' }).click()
    await expect(tile.locator('.code-editor-preview h1', { hasText: 'Docs Title' })).toBeVisible({ timeout: 10_000 })
    await expect(tile.locator('.code-editor-preview strong', { hasText: 'bold' })).toBeVisible()
    // and back to source
    await tile.locator('.preview-source-tab', { hasText: 'Source' }).click()
    await expect(tile.locator('.editor-slot:visible .monaco-editor')).toBeVisible()

    // Image → rendered as a data-URL <img>.
    await tile.locator('.file-row', { hasText: 'logo.svg' }).click()
    const img = tile.locator('.media-image img')
    await expect(img).toBeVisible({ timeout: 10_000 })
    expect(await img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  })

  test('drop an image → thumbnail chip, sent on submit, click-enlarges in a lightbox', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('image drop test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Drop a 1x1 PNG onto the composer → an image chip with a thumbnail appears.
    await tile.locator('.composer').evaluate((el) => {
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const file = new File([bytes], 'red.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }))
    })
    await expect(tile.locator('.context-chip-image .chip-thumb')).toBeVisible({ timeout: 5_000 })

    // Submitting clears the image chip (it was dispatched with the turn).
    await tile.locator('.composer-input').fill('describe this')
    await tile.getByRole('button', { name: 'Send' }).click()
    await expect(tile.locator('.context-chip-image')).toHaveCount(0, { timeout: 5_000 })

    // The sent image renders as a chat thumbnail that CLICK-ENLARGES into a
    // full-screen lightbox (Angel: the zoom-in cursor did nothing). Esc closes.
    const thumb = tile.locator('.msg-user-image').first()
    await expect(thumb).toBeVisible({ timeout: 5_000 })
    await thumb.click()
    await expect(page.locator('.lightbox-backdrop .lightbox-img')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.lightbox-backdrop')).toHaveCount(0)
  })

  test('per-workspace config: custom worktree dir + setup script', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    // configure a custom worktree folder and a setup script that drops a marker
    await page.evaluate(async () => {
      await window.hang4r.setSetting('worktreeDir', '.myworktrees')
      await window.hang4r.setSetting('setupScript', 'echo ran > SETUP_RAN.txt')
    })
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('worktree config test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Session ran in the CUSTOM dir (not the default), and the setup script ran.
    expect(existsSync(join(repo, '.myworktrees'))).toBe(true)
    expect(existsSync(join(repo, '.hang4r-worktrees'))).toBe(false)
    const { readdirSync } = await import('node:fs')
    const slug = readdirSync(join(repo, '.myworktrees'))[0]
    expect(existsSync(join(repo, '.myworktrees', slug, 'SETUP_RAN.txt'))).toBe(true)
  })

  test('worktree config is per-workspace (independent per repo)', async () => {
    launched = await launchApp()
    const { page } = launched
    const { readdirSync } = await import('node:fs')
    const repoA = makeScratchRepo()
    const repoB = makeScratchRepo()
    const a = await createProject(page, repoA)
    const b = await createProject(page, repoB)
    // each workspace gets its OWN worktree dir + setup script
    await page.evaluate(
      async ({ a, b }) => {
        await window.hang4r.setSetting(`worktreeDir:${a}`, '.wtA')
        await window.hang4r.setSetting(`setupScript:${a}`, 'echo A > MARKER_A.txt')
        await window.hang4r.setSetting(`worktreeDir:${b}`, '.wtB')
        await window.hang4r.setSetting(`setupScript:${b}`, 'echo B > MARKER_B.txt')
      },
      { a: a.id, b: b.id }
    )
    await page.reload()
    await page.waitForSelector('.app')

    // start a session in each workspace
    await page.locator('.project-row', { hasText: basename(repoA) }).locator('.ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('A')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.tile .status-dot.status-idle').first()).toBeVisible({ timeout: 20_000 })
    await page.locator('.project-row', { hasText: basename(repoB) }).locator('.ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('B')
    await page.getByRole('button', { name: /Start agent/ }).click()
    // session B opens SINGLE now (Cursor) — it replaces A in the sole pane, so
    // keying off `.tile` would match A (already idle) and race past B's worktree
    // setup. Wait on the sidebar rows instead: both sessions must reach idle.
    await expect(page.locator('.session-row .status-dot.status-idle')).toHaveCount(2, {
      timeout: 20_000
    })

    // A used .wtA with MARKER_A only; B used .wtB with MARKER_B only — no bleed.
    const slugA = readdirSync(join(repoA, '.wtA'))[0]
    const slugB = readdirSync(join(repoB, '.wtB'))[0]
    expect(existsSync(join(repoA, '.wtA', slugA, 'MARKER_A.txt'))).toBe(true)
    expect(existsSync(join(repoA, '.wtB'))).toBe(false)
    expect(existsSync(join(repoB, '.wtB', slugB, 'MARKER_B.txt'))).toBe(true)
    expect(existsSync(join(repoB, '.wtA'))).toBe(false)
  })

  test('polish: dirty-dot on tabs + expand hides the sidebar', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('polish test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()

    // Editing a file marks its tab dirty; saving clears it.
    await tile.locator('.file-row', { hasText: 'README.md' }).click()
    await tile.locator('.editor-slot:visible .monaco-editor').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' X')
    await expect(tile.locator('.editor-tab.editor-tab-dirty', { hasText: 'README.md' })).toBeVisible({ timeout: 5_000 })
    await tile.locator('.editor-slot:visible .code-editor-save').click()
    await expect(tile.locator('.editor-tab.editor-tab-dirty')).toHaveCount(0, { timeout: 5_000 })

    // Expand-to-focus hides the sidebar; restore brings it back.
    await expect(page.locator('.sidebar')).toBeVisible()
    await tile.locator('.tile-header [title*="Expand pane"]').click()
    await expect(page.locator('.sidebar')).toHaveCount(0, { timeout: 5_000 })
    await tile.locator('.tile-header [title*="Restore layout"]').click()
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5_000 })
  })

  test('polish: rename terminal shell + pin workspace to top', async () => {
    launched = await launchApp()
    const { page } = launched
    const repoA = makeScratchRepo()
    const repoB = makeScratchRepo()
    await createProject(page, repoA)
    await createProject(page, repoB)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row', { hasText: basename(repoA) }).locator('.ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('polish 2')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Rename a terminal shell via double-click.
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await tile.locator('.terminal-list-name').first().dblclick()
    await tile.locator('.terminal-list-rename').fill('buildserver')
    await page.keyboard.press('Enter')
    await expect(tile.locator('.terminal-list-name', { hasText: 'buildserver' })).toBeVisible({ timeout: 5_000 })

    // Pin workspace B → it jumps above A.
    expect((await page.locator('.project-name').allTextContents())[0]).toBe(basename(repoA))
    await page.locator('.project-row', { hasText: basename(repoB) }).click({ button: 'right' })
    await page.locator('.ctx-item', { hasText: 'Pin workspace' }).click()
    expect((await page.locator('.project-name').allTextContents())[0]).toBe(basename(repoB))
    await expect(page.locator('.project-row', { hasText: basename(repoB) }).locator('.project-pin')).toBeVisible()
  })

  test('polish: multi-select files + commit menu portal', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('polish 3')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()

    // Cmd-click two files → both selected → batch add-to-chat makes two chips.
    await tile.locator('.file-row', { hasText: 'README.md' }).click({ modifiers: ['Meta'] })
    await tile.locator('.file-row', { hasText: 'docs.md' }).click({ modifiers: ['Meta'] })
    await expect(tile.locator('.file-row-selected')).toHaveCount(2)
    await tile.locator('.file-row', { hasText: 'docs.md' }).click({ button: 'right' })
    await page.locator('.ctx-item', { hasText: 'Add 2 files to chat' }).click()
    await expect(tile.locator('.context-chip')).toHaveCount(2, { timeout: 5_000 })

    // Commit menu renders in a body-level portal (never clips inside a pane).
    await tile.locator('.commit-caret').click()
    await expect(page.locator('body > .commit-menu-portal')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.commit-menu-portal button', { hasText: 'Commit & Create PR' })).toBeVisible()
  })

  test('reasoning-effort picker persists (real claude --effort)', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('effort test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // Combined model+effort picker: open it, pick High effort; the trigger
    // reflects it and it persists across reloads (real setting round-trip).
    await tile.locator('.model-picker-trigger').click()
    await expect(tile.locator('.model-menu')).toBeVisible()
    await expect(tile.getByRole('button', { name: 'Xhigh', exact: true })).toBeVisible()
    await tile.getByRole('button', { name: 'High', exact: true }).click()
    await expect(tile.locator('.model-picker-effort')).toContainText('High')
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.tile .model-picker-effort')).toContainText('High', { timeout: 10_000 })
  })

  test('cmd+W scoped close + terminal split/exit', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('cw test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()

    // ⌘W with a file open closes the FILE, not the session.
    await tile.locator('.file-row', { hasText: 'README.md' }).click()
    await expect(tile.locator('.editor-tab')).toHaveCount(1)
    await page.keyboard.press('Meta+w')
    await expect(tile.locator('.editor-tab')).toHaveCount(0)
    await expect(page.locator('.tile')).toHaveCount(1)

    // Terminal: right-click menu, ⌘D split, and `exit` closes the pane.
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await tile.locator('.terminal-list-row').first().click({ button: 'right' })
    await expect(page.locator('.ctx-item', { hasText: 'Split right' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Meta+d')
    await expect(tile.locator('.terminal-list-row')).toHaveCount(2)
    await expect(tile.locator('.terminal-stack-split')).toBeVisible()
    // typing exit ends the pty → that terminal closes (back to 1)
    const term = tile.locator('.terminal-slot:visible .terminal-view').first()
    await term.click()
    await page.keyboard.type('exit\n')
    await expect(tile.locator('.terminal-list-row')).toHaveCount(1, { timeout: 15_000 })
  })

  test('slash-command menu inserts a command', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('slash test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    const ta = tile.locator('.composer-input')
    await ta.click()
    await ta.pressSequentially('/', { delay: 25 })
    await expect(tile.locator('.slash-menu')).toBeVisible({ timeout: 5_000 })
    await expect(tile.locator('.slash-cat', { hasText: 'Commands' })).toBeVisible()
    await ta.pressSequentially('for', { delay: 25 })
    await expect(tile.locator('.slash-item', { hasText: 'fork' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(ta).toHaveValue(/\/fork /)
  })

  test('theme selector switches + persists', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('theme test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.tile .status-dot.status-idle').first()).toBeVisible({ timeout: 20_000 })

    // Settings → General → Theme → Light applies data-theme + persists.
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('.settings-page')
    await page.locator('.settings-content select').first().selectOption('light')
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light')
    await page.locator('.settings-header .ghost-btn').click()
    await page.reload()
    await page.waitForSelector('.app')
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light')
  })

  test('explorer search: filename filter + content search', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('search test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()

    const box = tile.locator('.files-search-input')
    // filename filter
    await box.fill('index')
    await expect(tile.locator('.search-results .file-row', { hasText: 'index.js' })).toBeVisible({ timeout: 5_000 })
    // content search → dedicated Search panel (Cursor-style find & replace)
    await tile.locator('.files-search-mode').click()
    const panel = tile.locator('.search-panel')
    await expect(panel).toBeVisible({ timeout: 5_000 })
    await panel.locator('.search-input').first().fill('Docs Title')
    await expect(panel.locator('.search-group-name', { hasText: 'docs.md' })).toBeVisible({ timeout: 8_000 })
    await expect(panel.locator('.search-summary')).toContainText(/result/)
    await panel.locator('.search-match').first().click()
    await expect(tile.locator('.editor-tab', { hasText: 'docs.md' })).toBeVisible({ timeout: 8_000 })

    // flipping back to the explorer and returning must NOT lose search state
    await tile.locator('button[title="Show file tree"]').click()
    await expect(tile.locator('.files-search-input')).toBeVisible()
    await tile.locator('.files-search-mode').click()
    await expect(panel.locator('.search-input').first()).toHaveValue('Docs Title')
    await expect(panel.locator('.search-group-name', { hasText: 'docs.md' })).toBeVisible({ timeout: 8_000 })
  })

  test('monaco changed-line gutter shows git dirty-diff', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('gutter test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()

    // Edit + save README → the new line gets a green 'added' gutter bar.
    await tile.locator('.file-row', { hasText: 'README.md' }).click()
    await tile.locator('.editor-slot:visible .monaco-editor').click()
    await page.keyboard.press('End')
    await page.keyboard.type('\nADDED_LINE')
    await tile.locator('.editor-slot:visible .code-editor-save').click()
    await expect(tile.locator('.editor-slot:visible .gutter-added').first()).toBeVisible({ timeout: 8_000 })
  })

  test('import a session (Cursor + Claude Code) continues in hang4r', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    // this machine has Cursor + Claude Code history; skip cleanly if a runner doesn't
    const available = await page.evaluate(() =>
      Promise.all([window.hang4r.cursorAvailable(), window.hang4r.claudeImportAvailable()])
    )
    test.skip(!available[0] && !available[1], 'no import sources')

    const btn = page.locator('.archived-open-btn', { hasText: 'Import a session' })
    await expect(btn).toBeVisible({ timeout: 5_000 })
    await btn.click()
    await expect(page.locator('.import-dialog')).toBeVisible()
    // Claude Code tab defaults to "my workspaces" (the scratch repo has no
    // history) — switch to "Everywhere" to see the machine's real sessions.
    await page.locator('.import-source-tab', { hasText: 'Claude Code' }).click()
    await page.locator('.import-dialog select').selectOption('all')
    const firstRow = page.locator('.import-row').first()
    await expect(firstRow).toBeVisible({ timeout: 15_000 })
    // rows preview the last message; the workspace filter dropdown is present
    await expect(page.locator('.import-dialog select')).toBeVisible()
    // continue one → a new hang4r session appears (title prefixed with ↳)
    await firstRow.locator('button', { hasText: 'Continue in hang4r' }).click()
    await expect(page.locator('.session-row').filter({ hasText: '↳' }).first()).toBeVisible({ timeout: 15_000 })
  })

  test('hooks timeline renders fired lifecycle hooks', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('hooks test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Hooks' }).click()
    const row = tile.locator('.hook-row').first()
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.locator('.hook-event')).toHaveText('PostToolUse')
    await expect(row.locator('.hook-status')).toHaveText('allowed')
  })

  test('env browser lists loaded skills/MCP/tools + searches', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('env test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Env', exact: true }).click()
    // groups render from the init event
    await expect(tile.locator('.env-group-head', { hasText: 'Skills' })).toBeVisible({ timeout: 8_000 })
    await expect(tile.locator('.env-group-head', { hasText: 'MCP servers' })).toBeVisible()
    await expect(tile.locator('.env-item-meta', { hasText: 'connected' })).toBeVisible()
    // search filters across groups
    await tile.locator('.env-search input').fill('artifact')
    await expect(tile.locator('.env-item-name', { hasText: 'artifact-design' })).toBeVisible()
    await expect(tile.locator('.env-item-name', { hasText: 'Bash' })).toHaveCount(0)
  })

  test('workspace: add without a prompt + remove', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    // registering a workspace must NOT open the New Agent (prompt) modal
    const proj = await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await expect(page.locator('.dialog-prompt')).toHaveCount(0)
    await expect(page.locator('.project-name')).toHaveCount(1)
    // remove the workspace → it disappears
    await page.evaluate((id) => window.hang4r.removeProject(id), proj.id)
    await expect
      .poll(() => page.evaluate(() => window.hang4r.listProjects().then((p) => p.length)))
      .toBe(0)
  })

  test('working panel: jump-to-session label + hide button', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('ask permission for a thing') // stays running
    await page.getByRole('button', { name: /Start agent/ }).click()
    const panel = page.locator('.working-panel')
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(panel.locator('.working-toggle')).toContainText('1 Working')
    // hide dismisses the panel (agent keeps running)
    await panel.locator('.working-hide').click()
    await expect(panel).toHaveCount(0)
  })

  test('title-bar running gauge shows a count per active backend, not one name', async () => {
    // Regression: the title bar used to fold every running session into one
    // generic "N running" chip — and separately, the real Codex adapter's
    // placeholder rate-limit event injected a `codex` key into the
    // Claude-only rateLimits map, rendering as a bogus "CODEX" gauge. With
    // Claude, Codex and Cursor all running at once, the strip must show all
    // three, never a single backend's name.
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    const { id: projectId } = await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // 'ask permission' keeps the fake adapter's turn open (status stays
    // running) so the gauge has a stable window to assert against
    for (const backend of ['claude', 'codex'] as const) {
      await page.evaluate(
        ({ pid, backend }) =>
          window.hang4r.createSession({
            projectId: pid,
            backend,
            environment: 'local',
            permissionMode: 'default',
            title: `${backend} probe`,
            firstPrompt: 'ask permission for a thing'
          }),
        { pid: projectId, backend }
      )
    }

    const gauge = page.locator('[data-testid="running-gauge"]')
    await expect(gauge).toBeVisible({ timeout: 10_000 })
    // never a bare backend id/name rendered as the gauge's own text
    await expect(gauge).not.toHaveText(/^codex$/i)
    await expect(gauge).not.toHaveText(/^claude$/i)
    await expect(gauge.locator('[data-backend="claude"]')).toContainText('1')
    await expect(gauge.locator('[data-backend="codex"]')).toContainText('1')
    // no bogus third entry for a backend that isn't actually running
    await expect(gauge.locator('[data-backend="cursor"]')).toHaveCount(0)

    // focus flipping between sessions must not change what the gauge shows —
    // it's a running-count indicator, not a "focused session" indicator, and
    // must stay honest either way
    await page.locator('.session-row', { hasText: 'claude probe' }).click()
    await expect(gauge.locator('[data-backend="claude"]')).toContainText('1')
    await expect(gauge.locator('[data-backend="codex"]')).toContainText('1')
  })

  test('sign-in status shows Claude/Codex/Cursor auth in Settings', async () => {
    launched = await launchApp()
    const { page } = launched
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('.settings-page')
    await page.locator('.settings-nav-item', { hasText: 'Models' }).click()
    await expect(page.locator('.auth-status')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.auth-row')).toHaveCount(3)
    // states resolve to a real value (not stuck on the initial 'Unknown')
    await expect(page.locator('.auth-row', { hasText: 'Claude Code' }).locator('.auth-state'))
      .toHaveText(/Signed in|Not signed in/, { timeout: 8_000 })
  })

  test('drag-reorder workspaces persists the order', async () => {
    launched = await launchApp()
    const { page } = launched
    await createProject(page, makeScratchRepo())
    await createProject(page, makeScratchRepo())
    await page.reload()
    await page.waitForSelector('.app')
    const rows = page.locator('.project-row')
    await expect(rows).toHaveCount(2)
    const before = await page.locator('.project-name').allTextContents()
    // drag the 2nd workspace onto the top half of the 1st → it moves to first
    const dt = await page.evaluateHandle(() => new DataTransfer())
    await rows.nth(1).dispatchEvent('dragstart', { dataTransfer: dt })
    await rows.nth(0).dispatchEvent('dragover', { dataTransfer: dt, clientY: 5 })
    await rows.nth(0).dispatchEvent('drop', { dataTransfer: dt, clientY: 5 })
    await expect
      .poll(() => page.locator('.project-name').first().textContent())
      .toBe(before[1])
    // persisted to the projectOrder setting
    const order = await page.evaluate(() => window.hang4r.getSetting('projectOrder'))
    expect(order).toBeTruthy()
  })

  test('workspace folder icon collapses/expands its sessions', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('folder test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.project-folder')).toBeVisible()
    await expect(page.locator('.session-row').first()).toBeVisible({ timeout: 8_000 })
    // collapse → sessions hidden; expand → back
    await page.locator('.project-folder').first().click()
    await expect(page.locator('.session-row')).toHaveCount(0)
    await page.locator('.project-folder').first().click()
    await expect(page.locator('.session-row').first()).toBeVisible({ timeout: 5_000 })
  })

  test('collapsed sidebar shows an icon rail (not fully hidden)', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('rail test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.tile .status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // collapse → the rail appears with action icons
    await page.keyboard.press('Meta+b')
    const rail = page.locator('.sidebar-rail')
    await expect(rail).toBeVisible({ timeout: 5_000 })
    expect(await rail.locator('.rail-btn').count()).toBeGreaterThanOrEqual(5)
    // an icon action works from the rail
    await rail.locator('.rail-btn[title="Settings"]').click()
    await expect(page.locator('.settings-page')).toBeVisible({ timeout: 5_000 })
  })

  test('drag a file from the explorer into the composer attaches it', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('dnd test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()
    const row = tile.locator('.file-row', { hasText: 'README.md' }).first()
    await row.waitFor({ timeout: 8_000 })
    const composer = tile.locator('.composer')
    const dt = await page.evaluateHandle(() => new DataTransfer())
    await row.dispatchEvent('dragstart', { dataTransfer: dt })
    await composer.dispatchEvent('dragover', { dataTransfer: dt })
    await composer.dispatchEvent('drop', { dataTransfer: dt })
    await expect(tile.locator('.context-chip', { hasText: 'README.md' })).toBeVisible({ timeout: 8_000 })
  })

  test('background tasks panel shows run_in_background commands + output', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('bg test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Tasks', exact: true }).click()
    const task = tile.locator('.bgtask').first()
    await expect(task).toBeVisible({ timeout: 8_000 })
    await expect(task.locator('.bgtask-status')).toHaveText('running')
    // both a background bash AND a Workflow (e.g. /deep-research) are captured
    await expect(tile.locator('.bgtask-kind', { hasText: 'bash' })).toBeVisible()
    await expect(tile.locator('.bgtask-kind', { hasText: 'workflow' })).toBeVisible()
    // expand → live output is tailed from the task's log file
    await task.locator('.bgtask-head').click()
    await expect(tile.locator('.bgtask-output')).toContainText('listening on :5173', { timeout: 8_000 })

    // the agent's TaskCreate/TaskUpdate task list renders too (Angel's report:
    // it ran in the conversation while this panel claimed "no tasks")
    await expect(tile.locator('.todo-row')).toHaveCount(1)
    await expect(tile.locator('.todo-row')).toContainText('fake task for turn 1')
    // a second turn creates task #2 and completes task #1
    await tile.locator('.composer-input').fill('turn two')
    await tile.getByRole('button', { name: 'Send' }).click()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await expect(tile.locator('.todo-row')).toHaveCount(2)
    await expect(tile.locator('.todo-completed')).toContainText('fake task for turn 1')
  })

  test('context gauge shows real window occupancy after a turn', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('gauge test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // the context meter reflects the (cache-inclusive) context size, not ~0%
    const meter = tile.locator('.ctx-meter')
    await expect(meter).toBeVisible({ timeout: 8_000 })
    const pct = parseInt((await tile.locator('.ctx-label').textContent()) ?? '0', 10)
    expect(pct).toBeGreaterThan(10)
    // sidebar stays quiet below 80% occupancy (pill only appears near the limit)
    await expect(page.locator('.session-ctx-pill')).toHaveCount(0)
  })

  test('sent user message: edit affordance opens rewind editor', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('rewind ui test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // hover the sent message → pencil appears → editor with the original text
    const card = tile.locator('.msg-user-card').first()
    await card.hover()
    await card.locator('.msg-edit-btn').click()
    const editor = tile.locator('.msg-edit-input')
    await expect(editor).toBeVisible()
    await expect(editor).toHaveValue('rewind ui test')
    await expect(tile.getByRole('button', { name: 'Send from here' })).toBeVisible()
    // Esc cancels back to the plain card (full rewind needs a real CC session —
    // covered by the manual --resume-session-at verification, not the fake agent)
    await editor.press('Escape')
    await expect(tile.locator('.msg-edit-input')).toHaveCount(0)
    await expect(card).toContainText('rewind ui test')
  })

  test('new agent: top button enabled + workspace & agent selectable', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    // top New Agent is usable with a workspace present (no focused session needed)
    const btn = page.locator('.new-agent-btn')
    await expect(btn).toBeEnabled()
    await btn.click()
    // the New Agent modal opens
    await expect(page.locator('.dialog-title', { hasText: 'New agent session' })).toBeVisible()
    // agent selector toggles between Claude and Codex
    const codex = page.locator('.dialog .segmented button', { hasText: 'Codex' })
    await codex.click()
    await expect(codex).toHaveClass(/segmented-active/)
    const claude = page.locator('.dialog .segmented button', { hasText: 'Claude Code' })
    await claude.click()
    await expect(claude).toHaveClass(/segmented-active/)
    // a workspace selector is present
    await expect(page.locator('.dialog select').first()).toBeVisible()
  })

  test('new agent: agent segments show glyphs and switching backend changes the model set', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.new-agent-btn').click()

    // the Agent segmented control carries a per-backend glyph on each of the 3 agents
    await expect(page.locator('.dialog .segmented-glyph')).toHaveCount(3)

    // on Claude, the Model select offers the Claude models (e.g. Sonnet 5)
    await page.locator('.dialog .segmented button', { hasText: 'Claude Code' }).click()
    const modelSelect = page.locator('.field-model-row select')
    await expect(modelSelect.locator('option', { hasText: 'Sonnet 5' })).toHaveCount(1)

    // switching the backend to Codex changes the model set — Sonnet 5 is gone
    await page.locator('.dialog .segmented button', { hasText: 'Codex' }).click()
    await expect(modelSelect.locator('option', { hasText: 'Sonnet 5' })).toHaveCount(0)
  })

  test('new agent: start with an empty prompt creates an idle, ready session', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    // Start is ALWAYS enabled — an empty prompt just creates the session
    const startBtn = page.getByRole('button', { name: /Start agent/ })
    await expect(startBtn).toBeEnabled()
    await startBtn.click()

    // the tile opens SINGLE + chat-only, with NO user card (no first turn sent)
    const tile = page.locator('.tile').first()
    await expect(tile).toBeVisible()
    await expect(page.locator('.pane')).toHaveCount(1)
    await expect(tile.locator('.chat-panel')).toBeVisible()
    await expect(tile.locator('.context-panel')).toHaveCount(0)
    await expect(tile.locator('.msg-user-card')).toHaveCount(0)
    // it sits idle, ready — not running
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // the terminal can be opened and used on this idle session
    await tile.getByRole('button', { name: 'Terminal' }).click()
    const term = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(term.locator('.xterm')).toBeVisible({ timeout: 15_000 })

    // and typing a first prompt now streams a real turn
    await tile.locator('.composer-input').fill('now do the first turn')
    await tile.getByRole('button', { name: 'Send' }).click()
    await expect(tile.locator('.msg-user-card')).toContainText('now do the first turn')
    await expect(tile.locator('.msg-assistant').first()).toContainText('turn 1', { timeout: 20_000 })
  })

  test('resume lands in the cwd-derived workspace, not the first', async () => {
    launched = await launchApp()
    const { page } = launched
    // a pre-existing "first" workspace acts as a decoy
    const decoy = makeScratchRepo()
    await createProject(page, decoy)
    const realRepo = makeScratchRepo() // the session's actual cwd — a different repo
    await page.reload()
    await page.waitForSelector('.app')
    const res = await page.evaluate(
      (cwd) => window.hang4r.resumeClaudeSession('ext-123', cwd, 'bandwidth-feat-d22'),
      realRepo
    )
    const sessions = await page.evaluate(() => window.hang4r.listSessions())
    const projects = await page.evaluate(() => window.hang4r.listProjects())
    const s = sessions.find((x) => x.id === res.id)!
    const proj = projects.find((p) => p.id === s.projectId)!
    // resumed in its OWN cwd + a workspace derived from it — never the decoy
    expect(s.cwd).toBe(realRepo)
    expect(s.environment).toBe('local')
    expect(proj.path).toBe(realRepo)
    expect(proj.path).not.toBe(decoy)
  })

  test('go to definition jumps cross-file via cmd-click', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    writeFileSync(join(repo, 'src', 'helper.js'), 'export function computeThing() {\n  return 42\n}\n')
    writeFileSync(join(repo, 'src', 'main.js'), "import { computeThing } from './helper.js'\ncomputeThing()\n")
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'symbols'], { cwd: repo })
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('gotodef test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()
    await tile.locator('.files-search-input').fill('main.js')
    await tile.locator('.search-results .file-row', { hasText: 'main.js' }).click()
    await expect(tile.locator('.editor-tab', { hasText: 'main.js' })).toBeVisible({ timeout: 8_000 })
    const line = tile
      .locator('.editor-slot:visible .view-line')
      .filter({ hasText: 'computeThing()' })
      .first()
    await line.waitFor({ timeout: 8_000 })
    await line.click({ modifiers: ['Meta'], position: { x: 45, y: 8 } })
    await expect(tile.locator('.editor-tab', { hasText: 'helper.js' })).toBeVisible({ timeout: 8_000 })
  })

  test('TS language service gives semantic hover (types, not git-grep)', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    writeFileSync(
      join(repo, 'src', 'math.ts'),
      'export function square(n: number): number {\n  return n * n\n}\nconst r = square(3)\n'
    )
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'ts'], { cwd: repo })
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('ts hover')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()
    await tile.locator('.files-search-input').fill('math.ts')
    await tile.locator('.search-results .file-row', { hasText: 'math.ts' }).click()
    await expect(tile.locator('.editor-tab', { hasText: 'math.ts' })).toBeVisible({ timeout: 8_000 })
    const useLine = tile
      .locator('.editor-slot:visible .view-line')
      .filter({ hasText: 'const r = square' })
      .first()
    // The TS worker indexes in the background and takes longer under full-suite
    // load — a single hover attempt flakes. Re-hover until the language service
    // answers with a real type signature (git-grep cannot produce one).
    await expect(async () => {
      await page.mouse.move(5, 5) // dismiss any stale hover between attempts
      await useLine.getByText('square', { exact: false }).first().hover()
      await expect(page.locator('.monaco-hover-content').first()).toContainText(
        'function square(n: number): number',
        { timeout: 3_000 }
      )
    }).toPass({ timeout: 30_000, intervals: [1_000] })
  })

  test('inline git gutter peek shows the hunk diff in the editor', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('inline peek')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    // agents open chat-only now (Cursor) — open Files for the tree/editor steps
    await tile.getByRole('button', { name: 'Files' }).click()
    await tile.locator('.file-row', { hasText: 'README.md' }).first().click()
    await tile.locator('.editor-slot:visible .monaco-editor').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' PEEK_EDIT')
    await tile.locator('.editor-slot:visible .code-editor-save').click()
    await page.waitForTimeout(500)
    const bar = tile
      .locator('.editor-slot:visible .gutter-modified, .editor-slot:visible .gutter-added')
      .first()
    await expect(bar).toBeVisible({ timeout: 8_000 })
    await bar.click({ force: true })
    // the peek renders the hunk diff inline (removed/added lines), not just buttons
    await expect(tile.locator('.git-peek-zone')).toBeVisible({ timeout: 5_000 })
    await expect(tile.locator('.git-peek-body .git-peek-add').first()).toContainText('PEEK_EDIT', {
      timeout: 5_000
    })
  })

  test('permission mode: composer control changes mode + Shift+Tab cycles', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('perm mode test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // the control is visible in the composer footer and mirrors the session's
    // mode (the new-agent dialog defaults to acceptEdits)
    const select = tile.locator('.perm-mode-select')
    await expect(select).toBeVisible()
    await expect(select).toHaveValue('acceptEdits')

    // changing it persists to session meta + reflects in the status footer
    await select.selectOption('bypassPermissions')
    await expect(select).toHaveValue('bypassPermissions')
    await expect(tile.locator('.tile-status')).toContainText('bypassPermissions')
    await expect(tile.locator('.composer-notice')).toContainText('Permission mode: Bypass')

    // Shift+Tab in the composer cycles through all four modes and wraps
    const composer = tile.locator('.composer-input')
    await composer.focus()
    for (const want of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
      await composer.press('Shift+Tab')
      await expect(select).toHaveValue(want)
    }
    // focus stayed in the composer (preventDefault kept it from tabbing away)
    await expect(composer).toBeFocused()
  })

  test('queues messages while running: edit, delete, auto-send in order', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    // this prompt makes the fake ask for permission → the session stays RUNNING,
    // giving a stable window to queue follow-ups against (no timing race)
    await page.locator('.dialog-prompt').fill('ask permission to start')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.permission-card')).toBeVisible({ timeout: 15_000 })

    // Submitting while running QUEUES the message (Enter submits — the Send
    // button is a Stop button mid-turn). Each queues in order; composer clears.
    const composer = tile.locator('.composer-input')
    await composer.fill('QUEUED ALPHA')
    await composer.press('Enter')
    await composer.fill('QUEUED BETA')
    await composer.press('Enter')
    await composer.fill('QUEUED GAMMA')
    await composer.press('Enter')
    await composer.fill('QUEUED DELTA')
    await composer.press('Enter')
    // the queue block shows one row per message + a live count in the header
    await expect(tile.locator('.queue-row')).toHaveCount(4)
    await expect(tile.locator('.queue-count')).toHaveText('4 Queued')
    await expect(composer).toHaveValue('')
    // nothing sent yet — still just the original prompt's user card
    await expect(tile.locator('.msg-user-card')).toHaveCount(1)

    // EDIT (pencil): BETA's text returns to the composer and its row disappears
    await tile.locator('.queue-row', { hasText: 'QUEUED BETA' }).locator('.queue-row-btn').first().click()
    await expect(composer).toHaveValue('QUEUED BETA')
    await expect(tile.locator('.queue-row')).toHaveCount(3)
    await expect(tile.locator('.queue-row', { hasText: 'QUEUED BETA' })).toHaveCount(0)
    // clear it so the edited draft isn't re-queued when the queue drains
    await composer.fill('')

    // DELETE (trash): GAMMA drops; ALPHA/DELTA order preserved
    await tile.locator('.queue-row', { hasText: 'QUEUED GAMMA' }).locator('.queue-row-del').click()
    await expect(tile.locator('.queue-row')).toHaveCount(2)
    await expect(tile.locator('.queue-count')).toHaveText('2 Queued')
    await expect(tile.locator('.queue-row', { hasText: 'QUEUED GAMMA' })).toHaveCount(0)

    // resolve the permission → the turn completes → the queue auto-drains, one
    // message per turn-complete, in FIFO order
    await tile.locator('.permission-card').getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(tile.locator('.queue-row')).toHaveCount(0, { timeout: 15_000 })
    await expect(tile.locator('.msg-user-card')).toHaveCount(3, { timeout: 15_000 })
    const cards = tile.locator('.msg-user-card')
    await expect(cards.nth(0)).toContainText('ask permission to start')
    await expect(cards.nth(1)).toContainText('QUEUED ALPHA')
    await expect(cards.nth(2)).toContainText('QUEUED DELTA')
  })

  test('interrupting a turn cancels its pending permission card', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('ask permission to start')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    const permCard = tile.locator('.permission-card')
    await expect(permCard).toBeVisible({ timeout: 15_000 })
    await expect(permCard.locator('.permission-actions button')).toHaveCount(4)

    // stop the turn while the permission is still pending → the request is
    // dead; the card must stop offering live approvals and read as cancelled
    await tile.locator('.composer-stop').click()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 15_000 })
    await expect(permCard.locator('.permission-decision')).toContainText('cancelled')
    await expect(permCard.locator('.permission-actions button')).toHaveCount(0)
  })

  test('answerable question card: renders options, answering continues the turn', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    // 'ask a question' makes the fake adapter emit a question-request (Claude's
    // AskUserQuestion analog) and HOLD the turn until the user picks an option
    await page.locator('.dialog-prompt').fill('ask a question please')
    await page.getByRole('button', { name: /Start agent/ }).click()

    const tile = page.locator('.tile').first()
    const qCard = tile.locator('.question-card')
    await expect(qCard).toBeVisible({ timeout: 15_000 })
    // the QUESTION TEXT and its options render (not a bare allow/deny)
    await expect(qCard.locator('.question-prompt')).toContainText('Which color do you prefer?')
    const options = qCard.locator('.question-option')
    await expect(options).toHaveCount(2)
    await expect(qCard.getByRole('button', { name: 'Red', exact: true })).toBeVisible()
    await expect(qCard.getByRole('button', { name: 'Blue', exact: true })).toBeVisible()
    // still holding the turn — no second user card, status not idle yet
    await expect(tile.locator('.status-dot.status-idle')).toHaveCount(0)

    // pick an option → single-choice submits immediately → turn completes
    await qCard.getByRole('button', { name: 'Blue', exact: true }).click()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 15_000 })
    // the card is now decided: shows the chosen answer, no more live buttons
    await expect(qCard.locator('.question-answer')).toContainText('Blue')
    await expect(qCard.locator('.question-option')).toHaveCount(0)
  })

  test('interrupting a turn cancels its pending question card', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('ask a question now')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    const qCard = tile.locator('.question-card')
    await expect(qCard).toBeVisible({ timeout: 15_000 })
    await expect(qCard.locator('.question-option')).toHaveCount(2)

    // stop while the question is still pending → it's dead; card stops offering
    // options and reads as cancelled (mirrors the permission-cancel behaviour)
    await tile.locator('.composer-stop').click()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 15_000 })
    await expect(qCard.locator('.question-answer')).toContainText('cancelled')
    await expect(qCard.locator('.question-option')).toHaveCount(0)
  })

  test('monaco view state (scroll position) survives a workspace re-split', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    // a long file so the initial viewport can't already show the last line
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`)
    lines[0] = 'TOP_MARKER_LINE'
    lines[lines.length - 1] = 'BOTTOM_MARKER_LINE'
    writeFileSync(join(repo, 'long.txt'), lines.join('\n') + '\n')
    // sessions run in a git worktree, not the scratch repo checkout — commit
    // so the file actually exists there
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'add long.txt'], { cwd: repo })
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('view state test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })

    // open the Files panel (agents now start chat-only), then the long file and
    // scroll near the bottom
    await tile.getByRole('button', { name: 'Files' }).click()
    await tile.locator('.file-row', { hasText: 'long.txt' }).click({ timeout: 15_000 })
    const activeEditor = tile.locator('.editor-slot:visible')
    await expect(activeEditor.locator('.view-lines')).toContainText('TOP_MARKER_LINE', { timeout: 15_000 })
    await activeEditor.locator('.monaco-editor').click()
    await page.keyboard.press('Meta+ArrowDown') // Monaco's Mac binding for "go to end of file"
    await expect(activeEditor.locator('.view-lines')).toContainText('BOTTOM_MARKER_LINE', { timeout: 10_000 })
    await expect(activeEditor.locator('.view-lines')).not.toContainText('TOP_MARKER_LINE')

    // forking the session opens it in a split (split:true) → the workspace
    // re-splits and the first tile's SessionTile (and the Monaco editor inside
    // it) unmounts and remounts. (A plain 2nd session now opens single, which
    // wouldn't keep this tile mounted — a fork keeps it and adds a pane.)
    await tile.locator('.tile-header button[title*="Duplicate"]').click()
    await expect(page.locator('.pane')).toHaveCount(2)

    // the open panel now SURVIVES the remount (contextTabMemo, QA hunt #10) —
    // no reopen click needed (clicking Files here would toggle it CLOSED).
    // long.txt must still be open and active — no re-click on .file-row — and
    // the SAME Monaco view state (scroll position) must survive the remount too
    await expect(
      tile.locator('.editor-tab.editor-tab-active', { hasText: 'long.txt' })
    ).toBeVisible({ timeout: 10_000 })
    const restoredEditor = tile.locator('.editor-slot:visible')
    await expect(restoredEditor.locator('.view-lines')).toContainText('BOTTOM_MARKER_LINE', { timeout: 10_000 })
    await expect(restoredEditor.locator('.view-lines')).not.toContainText('TOP_MARKER_LINE')
  })

  test('drag a sidebar session onto a pane edge splits side-by-side (no auto-split)', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // two agents, created one after the other
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('Alpha agent')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.pane')).toHaveCount(1)

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('Beta agent')
    await page.getByRole('button', { name: /Start agent/ }).click()
    // the 2nd agent must open SINGLE — creating it does NOT auto-split the workspace
    await expect(page.locator('.pane')).toHaveCount(1)
    await expect(page.locator('.session-row')).toHaveCount(2)

    // the sole open pane shows the just-created (focused) session
    const openTitle = await page.locator('.pane .tile-title').first().innerText()

    // drag the OTHER (non-focused) session from the sidebar onto the RIGHT half
    // of the open pane → it splits in AFTER the target (right = after)
    await dragTo(page, '.session-row:not(.session-row-focused)', '.pane', 'right')
    await expect(page.locator('.pane')).toHaveCount(2)

    // order matches the drop side: original stays left (pane 0), dragged is right (pane 1)
    await expect(page.locator('.pane').nth(0).locator('.tile-title')).toHaveText(openTitle)
    const draggedTitle = await page.locator('.pane').nth(1).locator('.tile-title').innerText()
    expect(draggedTitle).not.toBe(openTitle)
    // the dropped session is focused, in the pane it was dropped into
    await expect(page.locator('.pane').nth(1).locator('.tile.tile-focused')).toBeVisible()
  })

  test('drag a session that was never opened this run onto a pane loads its transcript', async () => {
    // Regression for a blank-pane bug: a session that only ever entered the
    // renderer via the onSessionUpdated broadcast (never routed through the
    // store's openSession, e.g. one restored from a previous run) had no
    // entry in the in-memory transcripts map. Dropping it into a split used
    // to show an empty pane forever — dropSessionOnPane never loaded it.
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    const { id: projectId } = await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // session A: created + opened the normal way (dialog → openSession)
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('Session A normal open')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.pane')).toHaveCount(1)

    // session B: created directly through the IPC bridge, bypassing the
    // store's createSession action (and therefore its openSession call) —
    // it reaches the sidebar only via the sessions:updated broadcast, so its
    // transcript is never loaded into the renderer's store this run.
    const sessionB = await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'default',
          title: 'DirectSessionB',
          firstPrompt: 'DIRECT_B_MARKER_TEXT'
        }),
      projectId
    )
    await expect(page.locator('.session-row')).toHaveCount(2)
    // make sure B's first-turn user-text event is actually persisted before
    // we drag it, so a blank pane afterward can only mean the drop bug
    await page.waitForFunction(async (id) => {
      const evs = await window.hang4r.getSessionEvents(id)
      return evs.some((e) => e.event.kind === 'user-text')
    }, sessionB.id)

    // click session A in the sidebar — opens it single, as the sole pane
    await page.locator('.session-row', { hasText: 'Session A normal open' }).click()
    await expect(page.locator('.pane')).toHaveCount(1)
    await expect(page.locator('.pane .tile-title')).toHaveText('Session A normal open')

    // drag session B's sidebar row onto the right half of A's pane (dragTo
    // dispatches a native dragstart on the source, which bubbles up to the
    // row's onDragStart — target the title span directly since dragTo uses
    // plain document.querySelector, not Playwright's extended selectors)
    await dragTo(page, '.session-title[title="DirectSessionB"]', '.pane', 'right')
    await expect(page.locator('.pane')).toHaveCount(2)

    const droppedTile = page.locator('.pane').nth(1)
    await expect(droppedTile.locator('.tile-title')).toHaveText('DirectSessionB')
    // the bug: this pane rendered with zero transcript items — assert its
    // first user card shows B's actual prompt, not an empty chat area
    await expect(droppedTile.locator('.msg-user-card')).toContainText('DIRECT_B_MARKER_TEXT')
  })

  test('hovering a session row reveals the actions pill without hiding the backend/status glyphs', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('Hover probe session')
    await page.getByRole('button', { name: /Start agent/ }).click()
    await expect(page.locator('.pane')).toHaveCount(1)

    const row = page.locator('.session-row').first()
    const actions = row.locator('.session-actions')
    const backendGlyph = row.locator('.session-backend')

    // not hovered: actions pill is present but not interactive/visible
    await expect(actions).toHaveCSS('opacity', '0')

    await row.hover()
    await expect(actions).toHaveCSS('opacity', '1')
    await expect(actions).toBeVisible()
    // the backend identity glyph (left of the title) is untouched by the
    // hover pill (right side) — still rendered, not display:none/covered
    await expect(backendGlyph).toBeVisible()

    // the actions pill must sit exactly over the meta cluster, never bleed
    // into the title — assert the pill starts at/after the title's right
    // edge (the old bug had it starting ~70px inside the title's box)
    const titleBox = await row.locator('.session-title').boundingBox()
    const actionsBox = await actions.boundingBox()
    expect(titleBox).toBeTruthy()
    expect(actionsBox).toBeTruthy()
    expect(actionsBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width)

    // the pill's own background must match the row's actual painted
    // background (no mismatched patch) in both the focused and non-focused
    // hover cases
    const [rowBg, actionsBg] = await row.evaluate((el) => [
      getComputedStyle(el).backgroundColor,
      getComputedStyle(el.querySelector('.session-actions')!).backgroundColor
    ])
    expect(actionsBg).toBe(rowBg)
  })

  test('hovering a row WITH a ctx pill fully covers the meta cluster — no colored sliver poking out', async () => {
    // Regression: .session-meta and .session-actions share one grid cell via
    // `justify-items: end`, so each sized to its OWN content width and
    // right-aligned. When the ctx pill renders, meta (ctx pill + pin + age)
    // can be a couple px wider than actions (3 icon buttons) — actions'
    // narrower left edge left the ctx pill's colored background peeking out
    // on hover, jumbled with the actions icons.
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    const { id: projectId } = await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // cursor + a bracket context-window override keeps the fake adapter's
    // turn-1 contextTokens (90_000) comfortably over the pill's 80% threshold
    // in a single turn — see contextWindow.ts's cursor bracket-override path
    await page.evaluate(
      (pid) =>
        window.hang4r.createSession({
          projectId: pid,
          backend: 'cursor',
          model: 'fake-model[context=100000]',
          environment: 'local',
          permissionMode: 'default',
          title: 'ctx pill probe',
          firstPrompt: 'hello'
        }),
      projectId
    )
    const row = page.locator('.session-row', { hasText: 'ctx pill probe' })
    await expect(row.locator('.session-ctx-pill')).toBeVisible({ timeout: 10_000 })

    // pin it too, so meta = [ctx pill, pin glyph, age] — the widest
    // realistic meta cluster, most likely to out-grow the 3-icon actions pill
    await row.hover()
    await row.locator('.session-action[title="Pin to top"]').click()
    await page.mouse.move(2, 2)
    await expect(row.locator('.session-pin')).toBeVisible()

    await row.hover()
    const actions = row.locator('.session-actions')
    await expect(actions).toHaveCSS('opacity', '1')

    const metaBox = await row.locator('.session-meta').boundingBox()
    const actionsBox = await actions.boundingBox()
    expect(metaBox).toBeTruthy()
    expect(actionsBox).toBeTruthy()
    // actions must fully contain meta's footprint on every edge — not just
    // overlap it — so no part of the (still-rendered, still-opaque) meta
    // cluster is visible around the hover pill
    expect(actionsBox!.x).toBeLessThanOrEqual(metaBox!.x + 0.5)
    expect(actionsBox!.x + actionsBox!.width).toBeGreaterThanOrEqual(metaBox!.x + metaBox!.width - 0.5)
    expect(actionsBox!.y).toBeLessThanOrEqual(metaBox!.y + 0.5)
    expect(actionsBox!.y + actionsBox!.height).toBeGreaterThanOrEqual(metaBox!.y + metaBox!.height - 0.5)
  })

  test('processes empty state teaches what dev processes are and its Add button opens the editor', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('Processes probe session')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await tile.locator('.tile-tab', { hasText: 'Processes' }).click()

    const empty = tile.locator('.proc-empty')
    await expect(empty).toBeVisible()
    // teaches: what they are (per-workspace, opt-in auto-start, per-session worktree)
    await expect(empty).toContainText(/per-workspace/i)
    await expect(empty).toContainText(/run on agent start/i)
    await expect(empty).toContainText(/worktree/i)
    // a concrete example
    await expect(empty.locator('code', { hasText: /^dev$/ })).toHaveCount(1)
    await expect(empty).toContainText('npm run dev')
    // versionable via .hang4r/settings.json
    await expect(empty).toContainText('devProcesses')
    await expect(empty).toContainText('.hang4r/settings.json')
    // no redundant header control while empty — the Add button here is the
    // one control for this action (one control per action)
    await expect(tile.locator('.proc-head button')).toHaveCount(0)

    // its Add button opens the same editor as Edit → Add, with one empty row
    await empty.locator('button', { hasText: 'Add process' }).click()
    await expect(tile.locator('.proc-edit-row')).toHaveCount(1)
    await expect(tile.locator('.proc-edit-row input.field').first()).toHaveValue('')

    // save one, reopen — the header now shows a clear edit affordance
    await tile.locator('.proc-edit-row .field').first().fill('dev')
    await tile.locator('.proc-edit-row .proc-cmd').fill('npm run dev')
    await tile.locator('button', { hasText: 'Save' }).click()
    await expect(tile.locator('.proc-empty')).toHaveCount(0)
    await expect(tile.locator('.proc-head button', { hasText: 'Edit processes' })).toBeVisible()
  })
})
