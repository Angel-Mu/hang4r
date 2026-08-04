import { test, expect } from '@playwright/test'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The macOS menu bar is hang4r-shaped (not Electron's defaults), and its items
 * dispatch the real app commands via `menu:command` (Angel: revamp the menu like
 * Cursor). Native menu CLICKS can't be driven in Playwright, so we assert the
 * menu STRUCTURE (main side) and that a menu:command reaches the renderer and
 * runs the action (renderer side).
 */
test('the app menu is hang4r-shaped and its commands dispatch to the app', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // (1) the menu bar has hang4r's structure, not Electron's default roles
    const topLabels: string[] = await launched.app.evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).map((i) => i.label)
    )
    expect(topLabels).toEqual(
      expect.arrayContaining(['hang4r', 'File', 'Edit', 'View', 'Session', 'Help'])
    )

    // (2) a menu item click (simulated via the IPC it sends) runs the command:
    // Command Palette opens
    await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'command-palette')
    )
    await expect(page.locator('.palette')).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('.palette')).toHaveCount(0)

    // Settings opens
    await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'settings')
    )
    await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 5_000 })
  } finally {
    await launched.app.close()
  }
})
