import { test, expect, type Page } from '@playwright/test'
import { basename } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * Configurable terminal key bindings (replaces the old fixed "natural text
 * editing" toggle — see docs on 'terminalKeymap' in terminalKeymap.ts).
 * Driven through a REAL PTY + shell so assertions prove bytes actually
 * reached the shell (readline word/line editing), not just that a keydown
 * fired in the renderer.
 */
test.describe('terminal key bindings', () => {
  let launched: LaunchedApp

  test.afterEach(async () => {
    await launched?.app.close()
  })

  async function openTerminal(page: Page) {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')
    // Force bash: the dev/CI shell may not have standard readline word/line
    // editing bound (e.g. a fish install without fish_default_key_bindings
    // loaded), which would make these sequences a no-op through no fault of
    // the keymap code. Bash's compiled-in emacs bindings are deterministic.
    await page.evaluate(() => window.hang4r.setSetting('terminalShell', '/bin/bash'))
    await expect(page.locator('.project-name')).toHaveText(basename(repo))
    await page.locator('.project-row .ghost-btn').first().click()
    await page.locator('.dialog-prompt').fill('terminal keymap test')
    await page.getByRole('button', { name: /Start agent/ }).click()
    const tile = page.locator('.tile').first()
    await expect(tile.locator('.status-dot.status-idle')).toBeVisible({ timeout: 20_000 })
    await tile.getByRole('button', { name: 'Terminal' }).click()
    await expect(tile.locator('.terminal-panel')).toBeVisible()
    const term = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(term.locator('.xterm')).toBeVisible({ timeout: 15_000 })
    // wait for the shell prompt to settle — see note in the second test.
    await expect(term).toContainText('bash-3.2$', { timeout: 10_000 })
    return { tile, term }
  }

  test('default keymap: natural text editing reaches the real shell', async () => {
    launched = await launchApp()
    const { page } = launched
    const { term } = await openTerminal(page)

    await term.click()
    await page.keyboard.type('aaa bbb')
    await page.keyboard.press('Alt+ArrowLeft') // word-back → cursor before 'bbb'
    await page.keyboard.type('X')
    await expect(term).toContainText('aaa Xbbb')

    await page.keyboard.press('Meta+ArrowLeft') // line-start
    await page.keyboard.type('Y')
    await expect(term).toContainText('Yaaa Xbbb')

    await page.keyboard.press('Meta+ArrowRight') // line-end
    await page.keyboard.type('Z')
    await expect(term).toContainText('Yaaa XbbbZ')

    await page.keyboard.press('Alt+Backspace') // kill-word → deletes 'XbbbZ'
    await page.keyboard.type('W')
    await expect(term).toContainText('Yaaa W')
    await expect(term).not.toContainText('XbbbZ')

    await page.keyboard.press('Meta+Backspace') // kill-line → clears back to line start
    await expect(term).not.toContainText('Yaaa W')

    await page.keyboard.type('cc dd')
    await page.keyboard.press('Meta+ArrowLeft')
    await page.keyboard.press('Alt+ArrowRight') // word-forward → cursor after 'cc'
    await page.keyboard.type('Q')
    await expect(term).toContainText('ccQ dd')

    await page.keyboard.press('Control+c') // cancel the dangling input line
  })

  test('editing the keymap in Settings changes what a NEW terminal sends', async () => {
    launched = await launchApp()
    const { page } = launched
    const { tile } = await openTerminal(page)

    // Settings → Keyboard → Terminal key bindings: remove the default kill-line
    // (⌘⌫) binding and add a custom send-text binding via the Record flow.
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('.settings-page')
    await page.locator('.settings-nav-item', { hasText: 'Keyboard' }).click()
    const rows = page.locator('.keymap-row')
    await expect(rows).toHaveCount(6)
    // rows follow NATURAL_KEYMAP_DEFAULTS order: [4] is kill-line (⌘⌫)
    await expect(rows.nth(4).locator('.keymap-chip')).toHaveText('⌘⌫')
    await rows.nth(4).locator('.ghost-btn').click()
    await expect(rows).toHaveCount(5)

    await page.locator('.keymap-editor .ghost-btn', { hasText: 'Add binding' }).click()
    const newRow = page.locator('.keymap-row').last()
    await expect(newRow.locator('.keymap-chip')).toHaveText('Press keys…')
    await page.keyboard.press('Control+Shift+ArrowDown')
    await expect(newRow.locator('.keymap-chip')).toHaveText('⌃⇧↓')
    await newRow.locator('select').selectOption('send-text')
    await newRow.locator('.keymap-text').fill('echo KEYMAP_OK\\n')

    await page.locator('.settings-footer .primary-btn', { hasText: 'Save' }).click()
    await expect(page.locator('.settings-saved')).toBeVisible()
    await page.locator('.settings-header .ghost-btn').click()
    await expect(page.locator('.settings-page')).toHaveCount(0)

    // Only NEW terminal mounts pick up the edited keymap.
    await tile.locator('.terminal-list-head .ghost-btn', { hasText: '+' }).click()
    await expect(tile.locator('.terminal-list-row')).toHaveCount(2)
    const newTerm = tile.locator('.terminal-slot:visible .terminal-view')
    await expect(newTerm.locator('.xterm')).toBeVisible({ timeout: 15_000 })
    // wait for the shell prompt to settle before typing — a freshly-mounted
    // terminal can redraw its prompt a few times as the container's initial
    // resize events land, and keys sent mid-redraw can race the shell.
    await expect(newTerm).toContainText('bash-3.2$', { timeout: 10_000 })
    await newTerm.click()

    // The custom send-text binding executes the escaped command in the shell.
    await page.keyboard.press('Control+Shift+ArrowDown')
    await expect(newTerm).toContainText('KEYMAP_OK', { timeout: 15_000 })

    // The removed kill-line binding no longer clears the line. (trailing '!'
    // so the assertion never depends on the exact character the terminal
    // cursor is currently sitting on.)
    await page.keyboard.type('should-survive!')
    await expect(newTerm).toContainText('should-survive')
    await page.keyboard.press('Meta+Backspace')
    await expect(newTerm).toContainText('should-survive')
  })

  test('malformed-shape keymap (valid JSON, bad elements) falls back to defaults, no crash', async () => {
    launched = await launchApp()
    const { page } = launched
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    // valid JSON array whose elements lack a .key chord — QA hunt #9 bug #1:
    // this used to throw a TypeError in matchesChord on EVERY keystroke
    await page.waitForSelector('.app')
    await page.evaluate(() =>
      window.hang4r.setSetting('terminalKeymap', JSON.stringify([{ action: 'word-back' }, 1, null]))
    )
    const { term } = await openTerminal(page)
    await term.click()
    await page.keyboard.type('aaa bbb')
    // fallback keymap = natural defaults, so word-back must still work
    await page.keyboard.press('Alt+ArrowLeft')
    await page.keyboard.type('X')
    await expect(term).toContainText('aaa Xbbb')
    expect(pageErrors).toEqual([])
  })

  test('a bound PRINTABLE key sends only the action bytes, not the literal char', async () => {
    launched = await launchApp()
    const { page } = launched
    await page.waitForSelector('.app')
    // bind plain "z" → send-text — QA hunt #9 bug #2: the literal z used to
    // reach the shell too (xterm reads printables from the textarea input
    // event, which `return false` alone doesn't stop)
    await page.evaluate(() =>
      window.hang4r.setSetting(
        'terminalKeymap',
        JSON.stringify([
          {
            key: { key: 'z', meta: false, alt: false, ctrl: false, shift: false },
            action: 'send-text',
            text: 'PAYLOAD'
          }
        ])
      )
    )
    const { term } = await openTerminal(page)
    await term.click()
    await page.keyboard.press('z')
    await page.keyboard.type('!') // settle char so the assertion isn't cursor-racy
    await expect(term).toContainText('PAYLOAD!')
    await expect(term).not.toContainText('PAYLOADz')
    await expect(term).not.toContainText('zPAYLOAD')
  })
})
