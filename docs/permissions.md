# macOS permissions and hang4r — what's actually required

Short answer: **hang4r itself requires no special permissions.** It reads the
workspace folders you add, its own settings, and the session histories of the
CLIs it wraps (`~/.claude`, `~/.codex`, `~/.cursor`) — none of which are
TCC-protected.

## Then why do prompts appear?

macOS attributes a **child process's** file access to the app that hosts it.
Your agents (claude / codex / cursor-agent) and anything you run in hang4r's
terminals are children of hang4r — so when one of them touches a protected
location, macOS shows a prompt with *hang4r's* name on it:

| Prompt | Real trigger | Required? |
| --- | --- | --- |
| Photos / Media & Apple Music | an agent or shell command read `~/Pictures` / `~/Music` (e.g. a broad `grep`/`find`) | **No — deny is safe** unless your agent genuinely works there |
| Removable / Network Volumes | a child touched `/Volumes/...` | Same |
| Desktop / Documents / Downloads | a child (or a workspace you added) lives there | Only if your workspace is there |
| Local Network | a dev server / tool you ran spoke on the LAN | Only for LAN dev servers |
| "Access data from other apps" | fixed in 1.0.0 — only appears now if you open Import → Cursor tab (reads Cursor's local session DB, read-only) | Only for Cursor IDE imports |
| Full Disk Access | never requested by hang4r; macOS lists apps there when *something* probed broadly | **No** |

This is the same behavior you'll see for iTerm, Cursor, Zed, or any app that
hosts terminals — check those very lists in System Settings and you'll find
them side by side with hang4r.

## Recommendations

- Grant only what your actual workflow needs (usually: the folder prompts for
  where your repos live).
- Revoke anything you granted in surprise: System Settings → Privacy &
  Security → the category → toggle hang4r off. Nothing in hang4r breaks.
- hang4r's prompts include an explanation string (from 1.0.0) so it's clear
  the access came from an agent/terminal command, not the app itself.
