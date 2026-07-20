import { test, expect } from '@playwright/test'
import { basename, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchApp, makeScratchRepo, createProject, type LaunchedApp } from './helpers'

/**
 * The New Agent dialog pre-fills environment/permission-mode/model from the
 * documented settings — Settings → General's defaultModel/defaultPermissionMode/
 * defaultEnvironment, plus hand-edited agents.<backend>.<field> in settings.json
 * — instead of always opening on hardcoded fallbacks. Resolution order:
 * workspace agents.* beats app agents.* beats defaultModel/defaultPermissionMode
 * beats the built-in fallback ('worktree' / 'acceptEdits' / '' model).
 */
test.describe('New Agent dialog default pre-fill', () => {
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.app.close()
    launched = undefined
  })

  test('resolution order, backend/workspace re-apply, manual edits survive', async () => {
    launched = await launchApp()
    const { page, userDataDir } = launched
    const repoA = makeScratchRepo()
    const repoB = makeScratchRepo()
    await createProject(page, repoA)
    await createProject(page, repoB)

    // App-global file: agents.claude.* + agents.codex.permissionMode, plus a
    // defaultModel/defaultPermissionMode that should lose to the agents.* pair.
    writeFileSync(
      join(userDataDir, '.hang4r', 'settings.json'),
      JSON.stringify(
        {
          defaultModel: 'opus',
          defaultPermissionMode: 'plan',
          defaultEnvironment: 'local',
          agents: {
            claude: { model: 'opus', permissionMode: 'bypassPermissions' },
            codex: { permissionMode: 'default' }
          }
        },
        null,
        2
      )
    )
    // Workspace file for repo A only — overrides the Claude agent default for
    // that project; repo B has no override file at all.
    mkdirSync(join(repoA, '.hang4r'), { recursive: true })
    writeFileSync(
      join(repoA, '.hang4r', 'settings.json'),
      JSON.stringify({ agents: { claude: { model: 'haiku', permissionMode: 'default' } } }, null, 2)
    )

    await page.reload()
    await page.waitForSelector('.app')

    const openDialogFor = async (repo: string): Promise<void> => {
      await page
        .locator('.project-row', { hasText: basename(repo) })
        .locator('.ghost-btn.project-add')
        .click()
    }

    await openDialogFor(repoA)
    await expect(page.locator('.dialog')).toBeVisible()

    const modelSelect = page.locator('.field-model-row select')
    const permSelect = page
      .locator('.dialog select')
      .filter({ has: page.locator('option[value="bypassPermissions"]') })
    const worktreeBtn = page.locator('.dialog .segmented button', { hasText: 'Git worktree' })
    const localBtn = page.locator('.dialog .segmented button', { hasText: 'In-place' })
    const claudeBtn = page.locator('.dialog .segmented button', { hasText: 'Claude Code' })
    const codexBtn = page.locator('.dialog .segmented button', { hasText: 'Codex' })
    const workspaceSelect = page.locator('.dialog select').first()

    // env has no per-backend/workspace concept — resolves straight from
    // defaultEnvironment ('local'), not the built-in worktree fallback.
    await expect(localBtn).toHaveClass(/segmented-active/)
    await expect(worktreeBtn).not.toHaveClass(/segmented-active/)
    // workspace agents.claude.* (repo A) beats the app-level pair.
    await expect(modelSelect).toHaveValue('haiku')
    await expect(permSelect).toHaveValue('default')

    // Switching backend re-applies that backend's agents.* default —
    // agents.codex has no model entry (falls to '', defaultModel is
    // claude-only) but does have a permissionMode.
    await codexBtn.click()
    await expect(permSelect).toHaveValue('default')
    await expect(modelSelect).toHaveValue('')

    // Back to Claude: untouched fields re-resolve to the workspace override.
    await claudeBtn.click()
    await expect(modelSelect).toHaveValue('haiku')
    await expect(permSelect).toHaveValue('default')

    // Switching WORKSPACE re-resolves too — repo B has no override file, so
    // it falls through to the app-level agents.claude.* pair.
    await workspaceSelect.selectOption({ label: basename(repoB) })
    await expect(modelSelect).toHaveValue('opus')
    await expect(permSelect).toHaveValue('bypassPermissions')
    await workspaceSelect.selectOption({ label: basename(repoA) })
    await expect(modelSelect).toHaveValue('haiku')

    // Manually touch the model field — a later backend switch must not stomp it.
    await modelSelect.selectOption('sonnet')
    await codexBtn.click()
    await claudeBtn.click()
    await expect(modelSelect).toHaveValue('sonnet')

    // ...nor may a later workspace switch stomp it.
    await workspaceSelect.selectOption({ label: basename(repoB) })
    await expect(modelSelect).toHaveValue('sonnet')
  })

  test('no settings files: dialog opens on the built-in fallbacks (worktree / acceptEdits / default model)', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await expect(page.locator('.dialog')).toBeVisible()

    const modelSelect = page.locator('.field-model-row select')
    const permSelect = page
      .locator('.dialog select')
      .filter({ has: page.locator('option[value="bypassPermissions"]') })
    const worktreeBtn = page.locator('.dialog .segmented button', { hasText: 'Git worktree' })

    await expect(worktreeBtn).toHaveClass(/segmented-active/)
    await expect(permSelect).toHaveValue('acceptEdits')
    await expect(modelSelect).toHaveValue('')
  })

  // QA #13: a model value is backend-specific. Picking a Claude model then
  // switching to Codex must not leave the dropdown reading "Default model"
  // (the native <select> coerces the unmatched value) while the session is
  // silently created with the foreign Claude model. The shown value and the
  // created session's model must agree.
  test('a Claude model choice never leaks into a Codex session', async () => {
    launched = await launchApp()
    const { page } = launched
    const repo = makeScratchRepo()
    await createProject(page, repo)
    await page.reload()
    await page.waitForSelector('.app')

    await page.locator('.project-row .ghost-btn.project-add').first().click()
    await expect(page.locator('.dialog')).toBeVisible()

    const modelSelect = page.locator('.field-model-row select')
    const codexBtn = page.locator('.dialog .segmented button', { hasText: 'Codex' })

    // pick a Claude-specific model, then switch the backend to Codex
    await modelSelect.selectOption('sonnet')
    await codexBtn.click()

    // the dropdown must honestly read Default (Codex has no 'sonnet' option)
    await expect(modelSelect).toHaveValue('')

    // start the session and confirm it was NOT created with the Claude model
    await page.locator('.dialog .primary-btn', { hasText: /Start agent/ }).click()
    await expect(page.locator('.dialog')).toBeHidden()

    const created = await page.evaluate(async () => {
      const list = await window.hang4r.listSessions()
      return list.map((s) => ({ backend: s.backend, model: s.model }))
    })
    expect(created).toHaveLength(1)
    expect(created[0].backend).toBe('codex')
    expect(created[0].model).not.toBe('sonnet') // the leak: shown Default, made sonnet
  })
})
