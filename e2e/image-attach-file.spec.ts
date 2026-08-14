import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * An image attached to a Claude prompt must land as a REAL FILE on disk (not
 * only a base64 vision block), so file-based tools (an upload API, image
 * processing) have something to point at — a real user in a media-gen project
 * hit "images reach me as rendered pixels with no file behind them". The bytes
 * hang4r already holds are materialized to `<cwd>/.hang4r/attachments/` and the
 * agent-facing prompt text gets an `[Attached image saved to: <abs path>]` note,
 * while the vision block is STILL sent. The `.hang4r/` subtree self-ignores so
 * it never lands in the diff review or a per-turn checkpoint.
 *
 * Drives the IPC bridge directly (createSession + prompt) with a fake agent —
 * the OS file/paste picker can't be driven in e2e (contextBridge-frozen). The
 * fake adapter writes the FULL agent-facing text it received into
 * hang4r-fake-1.txt, so we can prove the path note reached the CLI input.
 */
// a 1x1 transparent PNG (no data: prefix), the shape PromptImage carries
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('an attached image is materialized to a real file and its path reaches the agent', async () => {
  const launched: LaunchedApp = await launchApp()
  const { page } = launched
  try {
    const repo = makeScratchRepo()
    const { id: projectId } = await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    // create a local session (no first turn) so the image prompt is turn 1
    const session = await page.evaluate(
      (a) =>
        window.hang4r.createSession({
          projectId: a.projectId,
          backend: 'claude',
          environment: 'local',
          permissionMode: 'acceptEdits',
          title: 'image attach'
        }),
      { projectId }
    )
    const cwd: string = session.cwd
    expect(cwd).toBeTruthy()

    // send a prompt carrying one image (paperclip/paste shape: base64 + mediaType)
    await page.evaluate(
      (a) =>
        window.hang4r.prompt(a.sessionId, 'describe this image', [
          { base64: a.b64, mediaType: 'image/png' }
        ]),
      { sessionId: session.id, b64: PNG_1x1 }
    )

    // a real file appears under <cwd>/.hang4r/attachments/
    const attachDir = join(cwd, '.hang4r', 'attachments')
    await expect
      .poll(() => (existsSync(attachDir) ? readdirSync(attachDir) : []), { timeout: 10_000 })
      .toHaveLength(1)
    const [attachName] = readdirSync(attachDir)
    expect(attachName).toMatch(/^img-\d+-0\.png$/)
    // the decoded bytes are a real PNG (magic header), not the base64 text
    const bytes = readFileSync(join(attachDir, attachName))
    expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47')

    // the agent-facing text (captured by the fake adapter) carries the path note
    const captured = join(cwd, 'hang4r-fake-1.txt')
    await expect.poll(() => (existsSync(captured) ? readFileSync(captured, 'utf8') : ''), {
      timeout: 10_000
    }).toContain(`[Attached image saved to: ${join(attachDir, attachName)}]`)

    // the whole .hang4r/ subtree self-ignores → invisible to git (no diff/checkpoint).
    // (the fake adapter also drops unrelated .hang4r-bg-*.log / hang4r-fake-*.txt
    // files directly in cwd — those aren't our attachments dir, so match the dir)
    expect(readFileSync(join(cwd, '.hang4r', '.gitignore'), 'utf8').trim()).toBe('*')
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
    expect(status).not.toContain('.hang4r/')
  } finally {
    await launched.app.close()
  }
})
