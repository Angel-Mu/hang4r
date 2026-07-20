// The "Resume in CLI (terminal)" affordance hands the user the exact command to
// continue a hang4r session in its own backend CLI. hang4r sessions run in a
// worktree cwd and are unnamed, so they don't appear in the raw CLI's resume
// PICKER — but resume-BY-ID works, and the command must (a) target the right
// backend's resume subcommand and (b) carry the session's permission mode so the
// resumed CLI doesn't re-prompt for approvals already granted (Angel's report).
// Pure unit tests (no Electron) — every flag verified against the CLIs' --help.
import { expect, test } from '@playwright/test'
import { resumeCliCommand } from '../src/renderer/src/resumeCli'

test.describe('resumeCliCommand — resume a hang4r session in its own CLI', () => {
  test('claude: resume by id, carries name + permission mode', () => {
    expect(resumeCliCommand('claude', 'sid-1', 'my session', 'bypassPermissions').cmd).toBe(
      "claude --resume sid-1 --dangerously-skip-permissions --name 'my session'"
    )
    expect(resumeCliCommand('claude', 'sid-1', 'plan work', 'plan').cmd).toBe(
      "claude --resume sid-1 --permission-mode plan --name 'plan work'"
    )
    expect(resumeCliCommand('claude', 'sid-1', 'default', 'default').cmd).toBe(
      "claude --resume sid-1 --permission-mode default --name 'default'"
    )
  })

  test('codex: resume by id with translated approval/sandbox flags', () => {
    expect(resumeCliCommand('codex', 'tid-9', 'x', 'bypassPermissions').cmd).toBe(
      'codex resume tid-9 --dangerously-bypass-approvals-and-sandbox'
    )
    expect(resumeCliCommand('codex', 'tid-9', 'x', 'acceptEdits').cmd).toBe(
      'codex resume tid-9 --ask-for-approval on-request --sandbox workspace-write'
    )
    expect(resumeCliCommand('codex', 'tid-9', 'x', 'default').cmd).toBe(
      'codex resume tid-9 --ask-for-approval on-request'
    )
  })

  test('cursor: resume by chatId with mode/force flags', () => {
    expect(resumeCliCommand('cursor', 'chat-7', 'x', 'plan').cmd).toBe('cursor-agent --resume chat-7 --mode plan')
    expect(resumeCliCommand('cursor', 'chat-7', 'x', 'bypassPermissions').cmd).toBe(
      'cursor-agent --resume chat-7 --force --approve-mcps'
    )
    expect(resumeCliCommand('cursor', 'chat-7', 'x', 'default').cmd).toBe('cursor-agent --resume chat-7')
  })

  test('a single-quote in the session name is shell-escaped (claude --name)', () => {
    expect(resumeCliCommand('claude', 'sid', "Angel's run", 'default').cmd).toBe(
      "claude --resume sid --permission-mode default --name 'Angel'\\''s run'"
    )
  })

  test('label names the backend so the terminal tab is identifiable', () => {
    expect(resumeCliCommand('claude', 'a', 't', 'default').label).toBe('resume · claude')
    expect(resumeCliCommand('codex', 'a', 't', 'default').label).toBe('resume · codex')
    expect(resumeCliCommand('cursor', 'a', 't', 'default').label).toBe('resume · cursor')
  })
})
