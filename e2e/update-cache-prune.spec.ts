import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launchApp, type LaunchedApp } from './helpers'

/**
 * Angel hit a disk-full warning and found the updater cache holding full copies
 * of the app — 335MB after a run of releases, never cleaned once installed. A
 * user who takes twenty updates should not be storing twenty of them.
 *
 * This drives the REAL cache directory, since that path is the thing being
 * asserted; each file is a few bytes.
 */
let launched: LaunchedApp | null = null
const cacheDir = join(homedir(), 'Library', 'Caches', 'hang4r-updater')
const planted: string[] = []

function plant(rel: string, body = 'x'): string {
  const full = join(cacheDir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
  planted.push(full)
  return full
}

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
  for (const f of planted) rmSync(f, { force: true })
  planted.length = 0
})

test('installers for versions already taken are deleted at startup', async () => {
  // an applied update's staging copy, and its pending twin
  const staged = plant('update.zip')
  const old = plant('pending/hang4r-0.0.1-arm64-mac.zip')
  const oldMap = plant('pending/hang4r-0.0.1-arm64-mac.zip.blockmap')
  // …and one for a version AHEAD of the running app, staged to install on quit
  const ahead = plant('pending/hang4r-99.0.0-arm64-mac.zip')

  launched = await launchApp()
  await launched.page.waitForSelector('.app')

  await expect.poll(() => existsSync(staged), { timeout: 15_000 }).toBe(false)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(oldMap)).toBe(false)
  // the pending newer update must survive — deleting it would break the install
  expect(existsSync(ahead)).toBe(true)
})

test('non-installer files in the cache are left alone', async () => {
  const info = plant('pending/update-info.json', '{}')
  launched = await launchApp()
  await launched.page.waitForSelector('.app')
  await launched.page.waitForTimeout(1500)
  expect(existsSync(info)).toBe(true)
})
