import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitService } from '../src/main/services/gitService'

const g = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

test('snapshot writes a ref, keeps the branch clean, and leaves the index alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snapunit-'))
  g(root, 'init', '-q', '.')
  g(root, 'config', 'user.email', 'a@b.c')
  g(root, 'config', 'user.name', 't')
  writeFileSync(join(root, 'f.txt'), 'base\n')
  g(root, 'add', '-A')
  g(root, 'commit', '-qm', 'base')
  g(root, 'worktree', 'add', '-q', join(root, 'wt'), '-b', 'feat')
  const wt = join(root, 'wt')

  // a deliberate partial staging that must survive
  writeFileSync(join(wt, 'f.txt'), 'staged-by-user\n')
  g(wt, 'add', 'f.txt')
  writeFileSync(join(wt, 'new.txt'), 'agent wrote this\n')

  const sha = await GitService.snapshot(wt, 'refs/hang4r/s1/turn-1', 'checkpoint: turn 1')
  expect(sha).toBeTruthy()

  expect(g(wt, 'for-each-ref', '--format=%(refname)', 'refs/hang4r/')).toContain('turn-1')
  expect(g(wt, 'log', '--oneline')).not.toContain('checkpoint')
  expect(g(wt, 'diff', '--cached', '--name-only')).toBe('f.txt') // staging untouched
  expect(g(wt, 'show', 'refs/hang4r/s1/turn-1:new.txt')).toBe('agent wrote this')
})
