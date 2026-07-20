import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

/** Launch the built Electron app with a fresh userData dir and the fake agent.
 *  Pass an existing `userDataDir` to reuse a pre-seeded one (e.g. a hang4r.db
 *  primed before first launch, for the settings-migration test). */
export async function launchApp(opts?: { userDataDir?: string }): Promise<LaunchedApp> {
  const userDataDir = opts?.userDataDir ?? mkdtempSync(join(tmpdir(), 'hang4r-e2e-'))
  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      HANG4R_FAKE_AGENT: '1',
      HANG4R_USER_DATA_DIR: userDataDir,
      // never steal the user's focus while tests run
      HANG4R_QUIET_TEST: '1'
    }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 20_000 })
  return { app, page, userDataDir }
}

/** Create a throwaway git repo with one committed file; returns its path. */
export function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hang4r-repo-'))
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir })
  }
  run('init', '-b', 'main')
  run('config', 'user.email', 'e2e@test')
  run('config', 'user.name', 'e2e')
  writeFileSync(join(dir, 'README.md'), '# scratch\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.js'), 'export const x = 1\n')
  // a file that imports index.js, so cmd-click go-to-file has something to resolve
  writeFileSync(join(dir, 'src', 'app.js'), "import { x } from './index.js'\nconsole.log(x)\n")
  // media files for the in-editor preview (image + markdown)
  writeFileSync(
    join(dir, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#bd93f9"/></svg>\n'
  )
  writeFileSync(join(dir, 'docs.md'), '# Docs Title\n\nSome **bold** preview text.\n')
  run('add', '-A')
  run('commit', '-m', 'init')
  return dir
}

/** Drive the exposed IPC bridge directly, bypassing native dialogs. */
export async function createProject(page: Page, path: string): Promise<{ id: string }> {
  try {
    return await page.evaluate((p) => window.hang4r.createProject(p), path)
  } catch {
    // rare: initial-load navigation destroys the first execution context
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('.app')
    return page.evaluate((p) => window.hang4r.createProject(p), path)
  }
}

/**
 * Drive a native HTML5 drag from `source` onto a half of `target`. Playwright's
 * mouse-based dragTo doesn't populate dataTransfer for real DnD, so we dispatch
 * synthetic DragEvents sharing one DataTransfer — the app's setData/getData
 * handlers run exactly as in a real drag. `side` picks the drop half (which
 * pane edge to split); 'center' aims at the middle (move/swap).
 */
export async function dragTo(
  page: Page,
  sourceSelector: string,
  targetSelector: string,
  side: 'left' | 'right' | 'top' | 'bottom' | 'center'
): Promise<void> {
  await page.evaluate(
    ({ sourceSelector, targetSelector, side }) => {
      const src = document.querySelector(sourceSelector)
      const tgt = document.querySelector(targetSelector)
      if (!src || !tgt) throw new Error(`drag source/target not found: ${sourceSelector} → ${targetSelector}`)
      const r = tgt.getBoundingClientRect()
      const pt = {
        left: { x: r.left + r.width * 0.1, y: r.top + r.height / 2 },
        right: { x: r.left + r.width * 0.9, y: r.top + r.height / 2 },
        top: { x: r.left + r.width / 2, y: r.top + r.height * 0.1 },
        bottom: { x: r.left + r.width / 2, y: r.top + r.height * 0.9 },
        center: { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }[side]
      const dataTransfer = new DataTransfer()
      const fire = (el: Element, type: string, x: number, y: number): void => {
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer })
        )
      }
      const s = src.getBoundingClientRect()
      fire(src, 'dragstart', s.left + 4, s.top + 4)
      fire(tgt, 'dragenter', pt.x, pt.y)
      fire(tgt, 'dragover', pt.x, pt.y)
      fire(tgt, 'drop', pt.x, pt.y)
      fire(src, 'dragend', pt.x, pt.y)
    },
    { sourceSelector, targetSelector, side }
  )
}
