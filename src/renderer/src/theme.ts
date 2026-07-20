export type Theme = 'system' | 'dark' | 'light' | 'nord' | 'solarized'

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark (hang4r)' },
  { value: 'light', label: 'Light' },
  { value: 'nord', label: 'Nord' },
  { value: 'solarized', label: 'Solarized Light' }
]

/** the concrete theme (system resolves to dark/light via the OS preference) */
export function resolveTheme(t: Theme): string {
  if (t === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return t
}

/** whether the resolved theme is a dark ground (drives Monaco's base theme) */
export function isDarkTheme(resolved: string): boolean {
  return resolved === 'dark' || resolved === 'nord'
}

/** stamp the resolved theme on <html data-theme> */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = resolveTheme(t)
}

/** current value of a CSS design token — so Monaco/xterm/find decorations
 *  track the ACTIVE theme instead of baking in one palette's hexes */
export function cssToken(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}
