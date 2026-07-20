import { defineConfig } from '@playwright/test'

/**
 * Electron E2E config. Tests launch the built app (out/) directly, so run
 * `npm run build` first (the `verify` script does this for you).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // Electron cold-start (Monaco worker warmup, PTY spawn) can flake one test per
  // run under load; a single retry keeps the gate reliable without masking real
  // failures (a genuinely broken test fails both attempts).
  retries: 1
})
