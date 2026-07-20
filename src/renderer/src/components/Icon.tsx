import type { JSX } from 'react'

export type IconName =
  | 'pin'
  | 'code'
  | 'paperclip'
  | 'archive'
  | 'folder'
  | 'folder-open'
  | 'image'
  | 'file'
  | 'key'
  | 'lock'
  | 'container'
  | 'message'
  | 'sparkle'
  | 'search'
  | 'settings'
  | 'panel-left'
  | 'file-plus'
  | 'folder-plus'
  | 'refresh'
  | 'collapse-all'
  | 'chevron-right'
  | 'chevron-down'
  | 'files'
  | 'split-h'
  | 'split-v'
  | 'replace-all'
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'panel-right'
  | 'globe'
  | 'terminal'
  | 'chevrons-left'
  | 'copy'
  | 'maximize'
  | 'minimize'
  | 'close'
  | 'pencil'
  | 'arrow-up'
  | 'trash'

// Monochrome line icons (Lucide-style), stroke = currentColor. Professional,
// theme-aware, and crisp at small sizes — replaces the emoji we used before.
const PATHS: Record<IconName, JSX.Element> = {
  pin: (
    <>
      <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
      <line x1="12" y1="14" x2="12" y2="21" />
    </>
  ),
  code: (
    <>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </>
  ),
  paperclip: <path d="M21 8.5V17a5 5 0 0 1-10 0V6a3 3 0 0 1 6 0v10a1 1 0 0 1-2 0V7" />,
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  'folder-open': (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H7a2 2 0 0 0-1.9 1.4L3 18V7Zm2.1 4.6A2 2 0 0 1 7 10h13.5a1 1 0 0 1 .95 1.3l-1.8 6A2 2 0 0 1 17.7 19H5a2 2 0 0 1-1.9-2.6l2-4.8Z" />
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.5 12.5 8-8M18 6l2 2" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  container: (
    <>
      <rect x="3" y="9" width="18" height="8" rx="1" />
      <path d="M7 9V6M11 9V6M15 9V6" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" />,
  sparkle: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  // Cursor/VS Code-style toolbar icons (Lucide shapes)
  'panel-left': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </>
  ),
  'file-plus': (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </>
  ),
  'folder-plus': (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <line x1="12" y1="10.5" x2="12" y2="16.5" />
      <line x1="9" y1="13.5" x2="15" y2="13.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </>
  ),
  'collapse-all': (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M4 16V5a2 2 0 0 1 2-2h11" />
      <line x1="11.5" y1="14.5" x2="17.5" y2="14.5" />
    </>
  ),
  'chevron-right': <polyline points="9 5 16 12 9 19" />,
  'chevron-down': <polyline points="5 9 12 16 19 9" />,
  // VS Code-style Explorer mark: two stacked pages
  files: (
    <>
      <path d="M15 3H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7Z" />
      <polyline points="15 3 15 7 19 7" />
      <path d="M6 8H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h8" />
    </>
  ),
  // editor split: side-by-side / stacked groups (Cursor/VS Code style)
  'split-h': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </>
  ),
  'split-v': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </>
  ),
  // replace-all: a·b → with an arrow loop (VS Code-ish)
  'replace-all': (
    <>
      <path d="M4 7h9a3 3 0 0 1 3 3v1" />
      <polyline points="13 8 16 11 19 8" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="15" width="7" height="5" rx="1.5" />
    </>
  ),
  // Per-backend identity marks — distinct by SHAPE first, tinted by CSS.
  // claude: Anthropic-style radiating burst
  claude: (
    <>
      <line x1="12" y1="3.5" x2="12" y2="20.5" />
      <line x1="3.5" y1="12" x2="20.5" y2="12" />
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  // codex: OpenAI-style hexagon
  codex: <polygon points="12 3 20 7.5 20 16.5 12 21 4 16.5 4 7.5" />,
  // cursor: the app's stylized pointer/caret
  cursor: <path d="M5 2.5l14.5 8-6.4 1.6-3 6.9L5 2.5Z" />,
  // panel toggle (Cursor-style): a square with its right half filled
  'panel-right': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="none" />
      <rect x="14" y="4" width="6" height="16" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <polyline points="7 9 11 12.5 7 16" />
      <line x1="12.5" y1="16" x2="17" y2="16" />
    </>
  ),
  'chevrons-left': (
    <>
      <polyline points="11 17 6 12 11 7" />
      <polyline points="18 17 13 12 18 7" />
    </>
  ),
  // duplicate / fork a session — two stacked pages (Lucide "copy")
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
    </>
  ),
  // expand a pane to fill the workspace — outward diagonal arrows (Lucide "maximize-2")
  maximize: (
    <>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </>
  ),
  // restore a pane back to the tiled layout — inward diagonal arrows (Lucide "minimize-2")
  minimize: (
    <>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </>
  ),
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  // edit a queued message — Lucide "pencil"
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  // send a queued message now — Lucide "arrow-up"
  'arrow-up': (
    <>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </>
  ),
  // remove a queued message — Lucide "trash-2"
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </>
  )
}

const FILLED = new Set<IconName>(['pin', 'sparkle', 'cursor'])

export function Icon({
  name,
  size = 14,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): JSX.Element {
  const filled = FILLED.has(name)
  return (
    <svg
      className={'icon' + (className ? ' ' + className : '')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
