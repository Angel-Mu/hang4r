import type { IconName } from './components/Icon'

export interface FileIcon {
  /** monochrome text badge (TS, JS, …) OR */
  glyph?: string
  /** a named SVG icon (image, pdf, …) */
  icon?: IconName
  color: string
}

/** Map a filename to a compact monochrome icon (VS Code-ish, self-contained). */
export function fileIcon(name: string): FileIcon {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''

  // special filenames
  if (lower === 'package.json' || lower === 'package-lock.json') return { glyph: 'PKG', color: '#8bc34a' }
  if (lower.startsWith('.git')) return { glyph: 'GIT', color: '#f05033' }
  if (lower === 'dockerfile' || lower.startsWith('docker')) return { icon: 'container', color: '#2496ed' }
  if (lower.endsWith('.md') || lower.endsWith('.mdx') || lower.startsWith('readme')) return { glyph: 'MD', color: '#42a5f5' }
  if (lower.startsWith('.env')) return { icon: 'key', color: '#d8a266' }

  const map: Record<string, FileIcon> = {
    ts: { glyph: 'TS', color: '#3178c6' },
    tsx: { glyph: 'TS', color: '#3178c6' },
    js: { glyph: 'JS', color: '#e8bb2e' },
    jsx: { glyph: 'JS', color: '#e8bb2e' },
    mjs: { glyph: 'JS', color: '#e8bb2e' },
    cjs: { glyph: 'JS', color: '#e8bb2e' },
    json: { glyph: '{}', color: '#d8a266' },
    css: { glyph: '#', color: '#42a5f5' },
    scss: { glyph: '#', color: '#c6538c' },
    less: { glyph: '#', color: '#4b6fa8' },
    html: { glyph: '<>', color: '#e34c26' },
    svg: { icon: 'image', color: '#ffb13b' },
    png: { icon: 'image', color: '#74b6cc' },
    jpg: { icon: 'image', color: '#74b6cc' },
    jpeg: { icon: 'image', color: '#74b6cc' },
    gif: { icon: 'image', color: '#74b6cc' },
    webp: { icon: 'image', color: '#74b6cc' },
    pdf: { icon: 'file', color: '#d97070' },
    py: { glyph: 'PY', color: '#4b8bbe' },
    rs: { glyph: 'RS', color: '#dea584' },
    go: { glyph: 'GO', color: '#00add8' },
    rb: { glyph: 'RB', color: '#cc342d' },
    java: { glyph: 'JV', color: '#e76f00' },
    c: { glyph: 'C', color: '#8a97b0' },
    cpp: { glyph: 'C+', color: '#8a97b0' },
    sh: { glyph: '›_', color: '#66bd7e' },
    fish: { glyph: '›_', color: '#66bd7e' },
    zsh: { glyph: '›_', color: '#66bd7e' },
    yml: { glyph: 'YML', color: '#cb171e' },
    yaml: { glyph: 'YML', color: '#cb171e' },
    toml: { glyph: 'TML', color: '#9c4221' },
    sql: { glyph: 'SQL', color: '#c9a26d' },
    lock: { icon: 'lock', color: '#787878' },
    txt: { glyph: '≡', color: '#9a9ab5' },
    vue: { glyph: 'V', color: '#42b883' },
    svelte: { glyph: 'S', color: '#ff3e00' }
  }
  return map[ext] ?? { glyph: '≡', color: '#6272a4' }
}
