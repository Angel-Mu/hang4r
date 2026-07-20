import type { BackendId, PermissionMode } from '../../shared/protocol'

/**
 * Build the interactive-CLI resume command for a session's OWN backend, so the
 * user can continue THIS conversation in a terminal. hang4r sessions run in a
 * worktree cwd and go unnamed, so they don't show in the raw CLI's own resume
 * PICKER — but resume-BY-ID works from any cwd, and this hands over the exact
 * command with the session's permission mode carried across so the resumed CLI
 * doesn't re-prompt for approvals already granted (Angel: the remote/CLI
 * conversation "is not with the same permissions we granted").
 *
 * Every flag is verified against the installed CLI's own `--help`:
 *  - claude:  `--resume <id>` · `-n/--name` · `--dangerously-skip-permissions`
 *             / `--permission-mode <mode>`
 *  - codex:   `codex resume <id>` · `--dangerously-bypass-approvals-and-sandbox`
 *             / `-a/--ask-for-approval on-request` `-s/--sandbox workspace-write`
 *  - cursor:  `cursor-agent --resume <id>` · `--mode plan` / `--force --approve-mcps`
 *
 * Kept as a pure, dependency-free module so it can be unit-tested without React.
 */
export function resumeCliCommand(
  backend: BackendId,
  id: string,
  title: string,
  mode: PermissionMode
): { cmd: string; label: string } {
  const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  switch (backend) {
    case 'claude': {
      const perm =
        mode === 'bypassPermissions' ? ' --dangerously-skip-permissions' : ` --permission-mode ${mode}`
      const name = title ? ` --name ${shq(title)}` : ''
      return { cmd: `claude --resume ${id}${perm}${name}`, label: 'resume · claude' }
    }
    case 'codex': {
      const perm =
        mode === 'bypassPermissions'
          ? ' --dangerously-bypass-approvals-and-sandbox'
          : mode === 'acceptEdits'
            ? ' --ask-for-approval on-request --sandbox workspace-write'
            : ' --ask-for-approval on-request'
      return { cmd: `codex resume ${id}${perm}`, label: 'resume · codex' }
    }
    case 'cursor': {
      const perm =
        mode === 'plan' ? ' --mode plan' : mode === 'bypassPermissions' ? ' --force --approve-mcps' : ''
      return { cmd: `cursor-agent --resume ${id}${perm}`, label: 'resume · cursor' }
    }
  }
}
