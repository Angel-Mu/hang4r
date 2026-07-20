# hang4r — Project Goal

## North star

**hang4r is an agentic coding IDE — a desktop app inspired by Cursor v3's Agents
Window — that manages many AI coding-agent sessions across projects, wrapping the
Claude Code and Codex CLIs (and, later, other agents) instead of raw APIs so it
keeps the CLIs' hooks, skills, subagents, MCP, and subscription billing.**

The bar: *it should run and feel like Cursor v3's agent view* — a multi-session
mission-control for agents with first-class review, terminal, browser, and
subagent visibility — but backed by your own Claude/Codex subscriptions and with
extra agentic utilities on top.

## Definition of done (the agreed feature set)

A build "does what it's supposed to" when a user can:

1. **Manage projects & sessions** — add projects; see all agent sessions grouped
   by project in a sidebar with live status; run several in parallel in a
   persistable **tiled workspace**.
2. **Create & drive agents** — start a Claude Code **or** Codex session, pick
   model / environment / permissions, and hold a multi-turn conversation with
   rich streaming (text, thinking, tool calls, **subagent tree**).
3. **Isolate work** — each session can run in its own **git worktree**;
   per-turn checkpoint commits enable rewind. `/best-of-n` runs the same task
   across backends/models for comparison.
4. **Review changes** — a **changed-files panel + diff viewer** with
   **inline comments that are fed back to the agent** as a structured
   follow-up (the differentiator Cursor doesn't ship), plus stage/commit/PR.
5. **Work in-context** — integrated **terminal** (xterm.js/PTY), **file
   browser**, and an **embedded browser** the agent can drive.
6. **Run anywhere** — local, git worktree, or **remote over SSH**.
7. **See the machinery** — **usage gauges** (Claude 5h+weekly, Codex plan,
   per-session token/cost), **hooks timeline**, **skills/MCP/plugin browser**,
   **subagent inspector**, and settings.

Non-goals (for now): a hosted cloud/relay tier; a VS Code fork; calling model
APIs directly with app-provided keys.

## Constraints

- **Distributable** desktop app; macOS-first but cross-platform-safe.
- **MIT-clean**: learn from AGPL/MIT references (opcode, Crystal) but copy no code.
- **Wrap the user's own authenticated CLIs** as subprocesses — never `--bare`,
  never embed subscription auth we aren't allowed to.
- **Own design language**, Cursor-v3-*inspired* information architecture.

## How we verify (the loop)

"Up and running" is a hard requirement. Each verification pass must confirm:

- **Builds**: `typecheck` + production `build` pass.
- **Boots**: the packaged app launches and the window renders with no console
  errors.
- **Works end-to-end**: an automated Electron E2E test (Playwright) drives the
  real app — creates a project, starts a real Claude session, and asserts
  streamed agent events render; exercises the diff/review path.
- **Feels like Cursor v3**: the milestone's target workflow is usable by hand.

The loop keeps closing the gap between the current build and the Definition of
Done above, milestone by milestone (see `README.md` for milestone status).
