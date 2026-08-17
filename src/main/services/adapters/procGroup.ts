/**
 * SIGTERM/SIGKILL the WHOLE process group `pid` leads (negative pid — POSIX
 * only, fine on this darwin/linux-targeted app). An agent CLI spawns
 * long-running descendants (background dev servers, shell tools); killing only
 * the CLI's own pid orphans them, leaving zombies that hold their ports (Angel:
 * agents left ports 3000/4000 open after quit). Spawning the CLI with
 * `detached: true` makes it its own group leader (pgid === pid), so `-pid`
 * reaches it and every descendant. try/catch: the group may already be gone
 * (ESRCH) by the time this runs — a no-op, not a bug.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // already dead — nothing to kill
  }
}
