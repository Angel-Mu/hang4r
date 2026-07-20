/**
 * Configurable terminal key bindings (iTerm2 "Key Mappings" style).
 *
 * Replaces the old fixed "natural text editing" preset with a user-editable
 * list of {keystroke → action} bindings, persisted as JSON under the
 * 'terminalKeymap' setting. Consumed by TerminalView (matching) and Settings
 * (editing) so both stay in sync on one schema.
 */

export type KeymapAction =
  | 'word-back'
  | 'word-forward'
  | 'line-start'
  | 'line-end'
  | 'kill-line'
  | 'kill-word'
  | 'clear-screen'
  | 'send-text'

export interface KeyChord {
  /** KeyboardEvent.key, e.g. 'ArrowLeft', 'Backspace', 'g' */
  key: string
  meta: boolean
  alt: boolean
  ctrl: boolean
  shift: boolean
}

export interface KeyBinding {
  key: KeyChord
  action: KeymapAction
  /** payload for 'send-text' — supports \e / \xNN / \n / \t / \r / \\ escapes */
  text?: string
}

export const ACTION_LABELS: Record<KeymapAction, string> = {
  'word-back': 'Word back',
  'word-forward': 'Word forward',
  'line-start': 'Line start',
  'line-end': 'Line end',
  'kill-line': 'Kill to line start',
  'kill-word': 'Kill word back',
  'clear-screen': 'Clear screen',
  'send-text': 'Send text…'
}

/** readline/terminal control sequences for the fixed actions (not send-text/clear-screen). */
const ACTION_SEQUENCES: Partial<Record<KeymapAction, string>> = {
  'word-back': '\x1bb',
  'word-forward': '\x1bf',
  'line-start': '\x01',
  'line-end': '\x05',
  'kill-line': '\x15',
  'kill-word': '\x17'
}

/** iTerm2 "natural text editing" preset — the old hardcoded default. */
export const NATURAL_KEYMAP_DEFAULTS: KeyBinding[] = [
  { key: { key: 'ArrowLeft', meta: false, alt: true, ctrl: false, shift: false }, action: 'word-back' },
  { key: { key: 'ArrowRight', meta: false, alt: true, ctrl: false, shift: false }, action: 'word-forward' },
  { key: { key: 'ArrowLeft', meta: true, alt: false, ctrl: false, shift: false }, action: 'line-start' },
  { key: { key: 'ArrowRight', meta: true, alt: false, ctrl: false, shift: false }, action: 'line-end' },
  { key: { key: 'Backspace', meta: true, alt: false, ctrl: false, shift: false }, action: 'kill-line' },
  { key: { key: 'Backspace', meta: false, alt: true, ctrl: false, shift: false }, action: 'kill-word' }
]

/** Turn a 'send-text' payload's escapes into literal bytes (iTerm2-style catch-all). */
export function parseSendText(raw: string): string {
  return raw.replace(/\\(x[0-9a-fA-F]{2}|e|n|t|r|\\)/g, (_m, esc: string) => {
    if (esc === 'e') return '\x1b'
    if (esc === 'n') return '\n'
    if (esc === 't') return '\t'
    if (esc === 'r') return '\r'
    if (esc === '\\') return '\\'
    return String.fromCharCode(parseInt(esc.slice(1), 16))
  })
}

/** The bytes to write to the PTY for a binding, or null for actions handled locally (clear-screen). */
export function resolveActionBytes(b: KeyBinding): string | null {
  if (b.action === 'send-text') return parseSendText(b.text ?? '')
  if (b.action === 'clear-screen') return null
  return ACTION_SEQUENCES[b.action] ?? null
}

/** Exact modifier match — meta/alt/ctrl/shift must all agree, keydown only. */
export function matchesChord(e: KeyboardEvent, chord: KeyChord): boolean {
  return (
    e.key === chord.key &&
    e.metaKey === chord.meta &&
    e.altKey === chord.alt &&
    e.ctrlKey === chord.ctrl &&
    e.shiftKey === chord.shift
  )
}

/** mac-style glyph label for a chord, e.g. {key:'ArrowLeft', alt:true} → '⌥←' */
export function chordLabel(chord: KeyChord): string {
  if (!chord.key) return ''
  const parts: string[] = []
  if (chord.ctrl) parts.push('⌃')
  if (chord.alt) parts.push('⌥')
  if (chord.shift) parts.push('⇧')
  if (chord.meta) parts.push('⌘')
  parts.push(keyGlyph(chord.key))
  return parts.join('')
}

const KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backspace: '⌫',
  Delete: '⌦',
  Enter: '↩',
  Tab: '⇥',
  Escape: '⎋',
  ' ': 'Space'
}

function keyGlyph(key: string): string {
  return KEY_GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
}

/**
 * Load the effective keymap: 'terminalKeymap' JSON if present and valid,
 * otherwise migrate from the retired 'terminalNaturalKeys' toggle (off →
 * empty, unset/on → the natural preset). Parses defensively — bad JSON
 * falls back to the same migration.
 */
/** Element-shape guard — a corrupted setting must not crash matchesChord. */
function isValidBinding(b: unknown): b is KeyBinding {
  if (typeof b !== 'object' || b === null) return false
  const kb = b as { key?: { key?: unknown }; action?: unknown }
  return typeof kb.key?.key === 'string' && typeof kb.action === 'string'
}

export async function loadTerminalKeymap(): Promise<KeyBinding[]> {
  const raw = await window.hang4r.getSetting('terminalKeymap')
  if (raw != null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      // any malformed element means the setting is corrupt — same fallback as
      // bad JSON, never a per-keystroke TypeError in the terminal handler
      if (Array.isArray(parsed) && parsed.every(isValidBinding)) return parsed
    } catch {
      /* fall through to migration */
    }
  }
  const legacy = await window.hang4r.getSetting('terminalNaturalKeys')
  return legacy === 'off' ? [] : NATURAL_KEYMAP_DEFAULTS
}
