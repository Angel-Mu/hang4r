import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import * as monaco from 'monaco-editor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { mdComponents } from './MarkdownBlocks'
import { useHang4r } from '../state/store'
import { onForgetSession, onRemapSessionPaths, remapKeyedMemo } from '../sessionUiMemos'
import { htmlDataUrl } from '../htmlPreview'
import { CsvTable } from './CsvTable'
import { ensureModel, loadProject, tsDefinition } from '../monacoProject'
import { isDarkTheme, resolveTheme, cssToken } from '../theme'
import { mediaKind } from './MediaViewer'
import { EditorFindBar } from './EditorFindBar'
import { ChatFindBar } from './ChatFindBar'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Wire Monaco's language workers for Vite (Electron renderer).
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

// Enable real syntax/semantic diagnostics (the red squiggles) for JS/TS.
// The monaco-editor barrel types stub `languages.typescript` as deprecated even
// though the runtime object is present (the language contribution is bundled),
// so we reach it through a cast and guard at runtime.
let diagnosticsConfigured = false
/* eslint-disable @typescript-eslint/no-explicit-any */
function ensureDiagnostics(): void {
  if (diagnosticsConfigured) return
  const ts = (monaco.languages as any).typescript
  if (!ts?.typescriptDefaults) return
  const compiler: Record<string, unknown> = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false, // keep JS to SYNTAX errors — no noisy "cannot find module"
    jsx: ts.JsxEmit.React,
    esModuleInterop: true,
    noEmit: true
  }
  // loadProject feeds the project's baseUrl/paths (so alias imports get real types
  // instead of `any`) and may run before OR after us — preserve whatever it set so
  // we never clobber the aliases back to nothing.
  const prev = ts.typescriptDefaults.getCompilerOptions?.() ?? {}
  if (prev.baseUrl) compiler.baseUrl = prev.baseUrl
  if (prev.paths) compiler.paths = prev.paths
  ts.typescriptDefaults.setCompilerOptions(compiler)
  ts.javascriptDefaults.setCompilerOptions(compiler)
  // TS: full syntax + semantic. JS: syntax only (semantic needs the whole
  // project graph, which a single in-memory model doesn't have → false errors).
  // Syntax squiggles only — NOT project-wide semantic validation. Full semantic
  // diagnostics make the single in-browser TS worker eagerly type-check the whole
  // synced model graph; in a big monorepo (~hundreds+ of files) that saturates
  // the one worker, so hover / autocomplete / go-to-definition all queue behind
  // it and go dead (Angel: "neither hover nor autocomplete works, only in big
  // projects"). The language service (hover/defs/completions) still answers
  // on-query without the proactive whole-project check.
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSyntaxValidation: false,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true
  })
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSyntaxValidation: false,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true
  })
  ts.typescriptDefaults.setEagerModelSync(true)
  ts.javascriptDefaults.setEagerModelSync(true)
  diagnosticsConfigured = true
  // one-time self-test, surfaced in DevTools (⌥⇧⌘I → Console): does the TS worker
  // actually START in THIS build? A blocked/crashed worker is otherwise invisible
  // — hover/completions/defs just silently die. This is how we find out WHY
  // IntelliSense is dead in the packaged app instead of guessing (Angel).
  void (async () => {
    try {
      const getWorker = ts.getTypeScriptWorker
      if (typeof getWorker !== 'function') {
        console.warn('[hang4r] IntelliSense self-test: getTypeScriptWorker unavailable')
        return
      }
      await getWorker()
      console.info('[hang4r] IntelliSense self-test: TS worker started OK')
    } catch (err) {
      console.error('[hang4r] IntelliSense self-test: TS worker FAILED to start —', err)
    }
  })()
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const HANG4R_DARK = 'hang4r-dark'

let ideNavKeysRegistered = false
/**
 * macOS IDE navigation/editing keys — registered ONCE, globally, not per editor.
 *
 * Monaco's standalone build doesn't bind ⌘←/→ (line start/end) or ⌘↑/↓ (file
 * top/bottom) on a MacBook (its defaults use Home/End/Fn keys a laptop lacks),
 * so those silently did nothing while ⌥+arrow word-jump worked (Angel's report).
 *
 * The previous fix bound them per-editor via `editor.addCommand`, but every
 * CodeEditor shares Monaco's ONE standalone keybinding service, and each
 * addCommand closes over its own editor with no focus scoping — so the
 * last-mounted editor's handler won for everyone, firing cursor moves on the
 * wrong (often hidden) editor once several files were open → the keys appeared
 * dead. A global keybinding RULE maps each chord to a core command that Monaco
 * always dispatches to the FOCUSED editor, so it just works with any number of
 * editors open. `when: editorTextFocus` keeps it from touching plain inputs.
 */
function ensureIdeNavKeybindings(): void {
  if (ideNavKeysRegistered) return
  ideNavKeysRegistered = true
  const { CtrlCmd, Shift, WinCtrl } = monaco.KeyMod
  const KC = monaco.KeyCode
  monaco.editor.addKeybindingRules([
    { keybinding: CtrlCmd | KC.LeftArrow, command: 'cursorHome', when: 'editorTextFocus' }, // ⌘← line start
    { keybinding: CtrlCmd | KC.RightArrow, command: 'cursorEnd', when: 'editorTextFocus' }, // ⌘→ line end
    { keybinding: CtrlCmd | Shift | KC.LeftArrow, command: 'cursorHomeSelect', when: 'editorTextFocus' }, // ⌘⇧← select to line start
    { keybinding: CtrlCmd | Shift | KC.RightArrow, command: 'cursorEndSelect', when: 'editorTextFocus' }, // ⌘⇧→ select to line end
    { keybinding: CtrlCmd | KC.UpArrow, command: 'cursorTop', when: 'editorTextFocus' }, // ⌘↑ file top
    { keybinding: CtrlCmd | KC.DownArrow, command: 'cursorBottom', when: 'editorTextFocus' }, // ⌘↓ file bottom
    { keybinding: CtrlCmd | Shift | KC.UpArrow, command: 'cursorTopSelect', when: 'editorTextFocus' }, // ⌘⇧↑ select to top
    { keybinding: CtrlCmd | Shift | KC.DownArrow, command: 'cursorBottomSelect', when: 'editorTextFocus' }, // ⌘⇧↓ select to bottom
    { keybinding: CtrlCmd | KC.KeyD, command: 'editor.action.addSelectionToNextFindMatch', when: 'editorTextFocus' }, // ⌘D multicursor
    { keybinding: CtrlCmd | WinCtrl | KC.UpArrow, command: 'editor.action.moveLinesUpAction', when: 'editorTextFocus' }, // ⌃⌘↑ move line up
    { keybinding: CtrlCmd | WinCtrl | KC.DownArrow, command: 'editor.action.moveLinesDownAction', when: 'editorTextFocus' } // ⌃⌘↓ move line down
  ])
}

// A vibrant, high-contrast token palette so EVERY language reads well on the dark
// ground — Angel: "syntax highlight is a good thing we should always have… in some
// cases it's difficult to read" (vs-dark's defaults are muted). Original hues (not
// a copy of Dracula/Sublime, just the same readable spirit). Matched by token
// PREFIX, so `string` also colors `string.html`, `string.value.json`, etc.
const HANG4R_TOKEN_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6b7394', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'cc93f0' },
  { token: 'operator', foreground: '9aa4c2' },
  { token: 'delimiter', foreground: '9aa4c2' },
  { token: 'string', foreground: '8fdf9f' },
  { token: 'string.key', foreground: '7ec8ff' }, // JSON keys distinct from values
  { token: 'string.escape', foreground: 'ff9d6a' },
  { token: 'number', foreground: 'ff9d6a' },
  { token: 'constant', foreground: 'ff9d6a' },
  { token: 'regexp', foreground: 'ff85b8' },
  { token: 'type', foreground: '59d1e6' },
  { token: 'namespace', foreground: '59d1e6' },
  { token: 'tag', foreground: 'cc93f0' },
  { token: 'metatag', foreground: 'cc93f0' },
  { token: 'attribute.name', foreground: '7ec8ff' },
  { token: 'attribute.value', foreground: '8fdf9f' },
  { token: 'annotation', foreground: '7ec8ff' },
  { token: 'variable.predefined', foreground: 'ff9d6a' },
  // CSV/TSV source mode (Table preview does the heavy lifting; these keep the raw
  // text from being a wall of white — the delimiters get color so columns read).
  { token: 'delimiter.csv', foreground: '7ec8ff' },
  { token: 'string.csv', foreground: '8fdf9f' },
  { token: 'number.csv', foreground: 'ff9d6a' },
  { token: 'identifier.csv', foreground: 'd6dbe8' }
]

/** (re)define the dark Monaco theme from the ACTIVE theme's tokens — called on
 *  every theme application, so dark and nord each get their own ground instead
 *  of a baked-in hex that matches neither. */
function ensureTheme(): void {
  const bg = cssToken('--bg', '#0e0f13')
  monaco.editor.defineTheme(HANG4R_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: HANG4R_TOKEN_RULES,
    colors: {
      'editor.background': bg,
      'editorGutter.background': bg,
      'editor.lineHighlightBackground': cssToken('--surface', '#15161c')
    }
  })
}

// Monaco has no built-in CSV language, so a .csv opened as-is is untokenized —
// all white, hard to read (Angel). Register a light tokenizer: quoted fields,
// numbers, and the delimiters themselves get color even in Source mode.
let csvRegistered = false
function ensureCsvLang(): void {
  if (csvRegistered) return
  csvRegistered = true
  monaco.languages.register({ id: 'csv' })
  monaco.languages.setMonarchTokensProvider('csv', {
    tokenizer: {
      root: [
        [/"/, { token: 'string.csv', next: '@qstring' }],
        [/[,\t;]/, 'delimiter.csv'],
        [/-?\d+(?:\.\d+)?(?=$|[,\t;])/, 'number.csv'],
        [/[^",\t;]+/, 'identifier.csv']
      ],
      qstring: [
        [/""/, 'string.csv'],
        [/[^"]+/, 'string.csv'],
        [/"/, { token: 'string.csv', next: '@pop' }]
      ]
    }
  })
}
ensureCsvLang()

/** the quoted string containing 1-based `column`, or null (for cmd-click imports) */
function quotedStringAt(line: string, column: number): string | null {
  const idx = column - 1
  for (const q of ['"', "'", '`']) {
    let start = -1
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== q) continue
      if (start === -1) {
        start = i
      } else {
        if (idx > start && idx <= i) return line.slice(start + 1, i)
        start = -1
      }
    }
  }
  return null
}

function langForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', md: 'markdown',
    py: 'python', rs: 'rust', go: 'go', sh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini',
    sql: 'sql', java: 'java', c: 'c', cpp: 'cpp', rb: 'ruby', php: 'php', csv: 'csv', tsv: 'csv'
  }
  return map[ext] ?? 'plaintext'
}

/**
 * Editable code editor (Monaco). Full editing, syntax highlighting, and save
 * (⌘S / Save button) back to disk via IPC. "Add selection to chat" from the
 * right-click menu attaches a context chip.
 */
export interface EditorHandle {
  isDirty: () => boolean
  save: () => Promise<void>
  /** user chose "Don't Save": mark the shared doc clean so a later open reloads from disk */
  discard: () => void
}

/**
 * Shared dirty state per `${sessionId}:${path}` — the Monaco MODEL is shared
 * across split groups, so "unsaved" is a property of the document, not of one
 * editor view. Keeps both views' Save buttons/dots in sync, and lets a
 * remounting editor know it must NOT clobber an unsaved model with disk
 * content (the silent-data-loss bug QA round 4 caught).
 */
const sharedDirty = new Map<string, boolean>()
const dirtyWatchers = new Set<(key: string, dirty: boolean) => void>()

// The model's `alternativeVersionId` at the last SAVED state, per doc. A content
// change is "dirty" only if the current id differs — so ⌘Z back to the saved text
// clears the dot (Monaco returns the SAME id when undo/redo lands on a prior
// content state) instead of leaving the tab falsely unsaved + un-closeable (Angel).
const savedVersionMemo = new Map<string, number>()

// ⌘S / ⇧⌘S are bound per-editor via editor.addCommand, but ALL CodeEditors share
// ONE Monaco standalone keybinding service — so the LAST-registered editor's
// handler wins for EVERY editor, and ⌘S would save a hidden/last-mounted editor
// instead of the one you're in (Angel: "⌘S doesn't work"; the same class as the
// ⌘F/⌘←→ keybinding bugs). These module-level refs always point at the FOCUSED
// editor's save fns (updated on onDidFocusEditorText), so whichever instance's
// handler Monaco actually runs, it saves the editor that has focus.
type SaveRef = { current: () => Promise<void> }
let activeSaveRef: SaveRef | null = null
let activeSaveAsRef: SaveRef | null = null

/** Preview/Source choice per `${sessionId}:${path}` — survives tab switches */
const previewModeMemo = new Map<string, boolean>()

/**
 * Scroll/cursor/selection per `${sessionId}:${path}` — survives both a file
 * switch (tab change reuses the same editor+model) and a full remount (the
 * workspace re-splitting unmounts/remounts SessionTile, recreating the Monaco
 * instance from scratch).
 */
const viewStateMemo = new Map<string, monaco.editor.ICodeEditorViewState>()

// which `fileToOpen` opens we've already focused the editor for — module-level
// so a later session-switch REMOUNT (SessionTile is keyed per session) doesn't
// re-steal focus from wherever the user is. Nonce is monotonic per open.
const focusedOpenNonces = new Set<number>()
// `sessionId:path` keys whose editor read FAILED and fell back to the preview
// overlay ONCE. Stops the preview re-opening every time the editor remounts (a
// panel switch) for a tab that can't load — Angel's infinite-modal loop. Cleared
// when the same path later reads successfully.
const previewFallbackDone = new Set<string>()

// archiving a session removes its worktree — drop its `${sessionId}:${path}`
// entries so the maps don't grow forever (QA hunt #9's leak finding)
onForgetSession((sessionId) => {
  const prefix = `${sessionId}:`
  for (const map of [sharedDirty, previewModeMemo, viewStateMemo, savedVersionMemo]) {
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) map.delete(key)
    }
  }
})
onRemapSessionPaths((sessionId, from, to) => {
  for (const map of [sharedDirty, previewModeMemo, viewStateMemo, savedVersionMemo]) {
    remapKeyedMemo(map as Map<string, unknown>, sessionId, from, to)
  }
  // the paths changed, so let a failed read be retried under the new name
  for (const key of [...previewFallbackDone]) {
    if (key.startsWith(`${sessionId}:`)) previewFallbackDone.delete(key)
  }
})

function setSharedDirty(key: string, dirty: boolean): void {
  if ((sharedDirty.get(key) ?? false) === dirty) return
  sharedDirty.set(key, dirty)
  for (const cb of dirtyWatchers) cb(key, dirty)
}

export function CodeEditor({
  sessionId,
  path,
  onAddToChat,
  onRegister,
  onDirtyChange,
  onSavedAs,
  active
}: {
  sessionId: string
  path: string
  onAddToChat: (label: string, text: string) => void
  /** register a save handle so the parent can flush unsaved changes on close */
  onRegister?: (path: string, handle: EditorHandle | null) => void
  /** an untitled buffer was named+saved, or a real file "saved as" → the parent
   *  swaps this tab's path from `oldPath` to the newly written `newPath` */
  onSavedAs?: (oldPath: string, newPath: string) => void
  /** notify the parent when the unsaved state changes (tab dirty-dot) */
  onDirtyChange?: (path: string, dirty: boolean) => void
  /** this file is the visible tab in its group — focus the editor when it becomes
   *  active so keyboard focus follows the file you switch to (otherwise the
   *  previous file kept focus and ⌘F opened ITS find bar, hidden — Angel) */
  active?: boolean
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null) // markdown-preview find scopes here
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // focus the editor when its file becomes the ACTIVE tab (false→true only, not
  // on mount — that would steal focus when the panel first opens). This moves
  // keyboard focus off the previously-viewed file so ⌘F, typing, and shortcuts
  // land on the file you're actually looking at (Angel).
  const wasActiveRef = useRef(!!active)
  useEffect(() => {
    if (active && !wasActiveRef.current) editorRef.current?.focus()
    wasActiveRef.current = !!active
  }, [active])
  // key (`${sessionId}:${path}`) of the file currently loaded into the editor's
  // model — lets the load-file effect know whose view state to save before it
  // swaps to a new file, and the unmount cleanup know whose to save on dispose.
  const viewStateKeyRef = useRef<string | null>(null)
  const addRef = useRef(onAddToChat)
  addRef.current = onAddToChat
  // an unsaved buffer with no disk path yet (`untitled:N`) — ⌘S names + writes it
  const isUntitled = path.startsWith('untitled:')
  const onSavedAsRef = useRef(onSavedAs)
  onSavedAsRef.current = onSavedAs
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  // ⌘F unified find bar over the editor (round 13 ①). Monaco routes ⌘F to us
  // via an editor command (see the create effect); a repeat ⌘F re-focuses.
  const [findOpen, setFindOpen] = useState(false)
  const [findToken, setFindToken] = useState(0)
  const openFindRef = useRef(() => {})
  openFindRef.current = (): void => {
    setFindOpen(true)
    setFindToken((t) => t + 1)
  }
  // ⌘F routed here by App.tsx when this editor is the VISIBLE one in the focused
  // tile but its input isn't the exact activeElement (switched files, focus on
  // another file's find box, …). Monaco's own ⌘F command still handles the
  // focused case; this covers the rest so ⌘F never "does nothing" on a file
  // you're looking at (Angel).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onFind = (): void => openFindRef.current()
    el.addEventListener('hang4r-editor-find', onFind)
    return () => el.removeEventListener('hang4r-editor-find', onFind)
  }, [])
  // save commands are bound once in the create effect; these refs let them call
  // the latest save fns (defined below — path/onSavedAs change across renders)
  const doSaveRef = useRef<() => Promise<void>>(async () => {})
  const doSaveAsRef = useRef<() => Promise<void>>(async () => {})
  const promptSaveAsRef = useRef<() => Promise<boolean>>(async () => false)
  const [truncated, setTruncated] = useState(false)
  // set when a tab's file can't be read AND can't be previewed (e.g. a removed
  // worktree's file restored on relaunch). Shows a quiet inline notice instead
  // of the old blocking "Couldn't open … for preview" modal Angel kept hitting.
  const [loadError, setLoadError] = useState(false)
  const [hasSel, setHasSel] = useState(false)
  // Preview/Source segmented control (md/html/csv). Which side a file OPENS on
  // is Settings → General's "Open previewable files in"; a per-doc choice always
  // wins over it, so leaving a tab and coming back doesn't snap you back.
  const defaultFileView = useHang4r((s) => s.defaultFileView)
  const [previewMode, setPreviewModeState] = useState(
    previewModeMemo.get(`${sessionId}:${path}`) ?? defaultFileView === 'preview'
  )
  const setPreviewMode = (v: boolean): void => {
    previewModeMemo.set(`${sessionId}:${path}`, v)
    setPreviewModeState(v)
  }
  // same component instance can be re-pointed at another file — re-read memo
  useEffect(() => {
    setPreviewModeState(
      previewModeMemo.get(`${sessionId}:${path}`) ?? defaultFileView === 'preview'
    )
  }, [sessionId, path, defaultFileView])
  const [previewText, setPreviewText] = useState('')
  const [previewSrc, setPreviewSrc] = useState('')
  const previewNonce = useRef(0)
  const kind = mediaKind(path)
  const previewable = kind === 'markdown' || kind === 'html' || kind === 'csv'
  // refs mirror live state so the unmount cleanup (deps []) sees current values
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const dirtyCbRef = useRef(onDirtyChange)
  dirtyCbRef.current = onDirtyChange

  // the shared-doc dirty key; both split views of a file resolve to the same one
  const dirtyKey = `${sessionId}:${path}`
  const dirtyKeyRef = useRef(dirtyKey)
  dirtyKeyRef.current = dirtyKey
  // stay in sync when the OTHER view of this doc edits/saves/discards it
  useEffect(() => {
    const watch = (key: string, d: boolean): void => {
      if (key === dirtyKeyRef.current) setDirty(d)
    }
    dirtyWatchers.add(watch)
    return () => {
      dirtyWatchers.delete(watch)
    }
  }, [])
  useEffect(() => {
    dirtyCbRef.current?.(path, dirty)
  }, [dirty, path])
  const truncatedRef = useRef(false)
  truncatedRef.current = truncated
  const cwd = useHang4r((s) => s.sessions.find((x) => x.id === sessionId)?.cwd)
  const environment = useHang4r((s) => s.sessions.find((x) => x.id === sessionId)?.environment)
  // live-apply the Settings font size to every open editor
  const editorFontSize = useHang4r((s) => s.editorFontSize)
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: editorFontSize })
  }, [editorFontSize])

  // HTML preview: serve the live buffer through hang4r-preview:// so RELATIVE
  // assets (images/css/js next to the file) resolve against the workdir — a
  // data: URL has no base. SSH sessions keep the data: URL (assets are remote).
  useEffect(() => {
    if (!(previewMode && kind === 'html')) return
    if (environment === 'ssh') {
      setPreviewSrc(htmlDataUrl(previewText))
      return
    }
    let stale = false
    const rel = path.replace(/^\.?\//, '')
    void window.hang4r.setPreviewDoc(sessionId, rel, previewText).then(() => {
      if (stale) return
      const enc = rel.split('/').map(encodeURIComponent).join('/')
      setPreviewSrc(`hang4r-preview://s/${sessionId}/${enc}?v=${++previewNonce.current}`)
    })
    return () => {
      stale = true
    }
  }, [previewMode, kind, environment, previewText, sessionId, path])
  const metaRef = useRef({ sessionId, path, cwd })
  metaRef.current = { sessionId, path, cwd }
  // inline git-gutter peek state (set in the editor-create effect + applyGutter)
  const changedLinesRef = useRef<number[]>([])
  const peekLineRef = useRef(0)
  const applyGutterRef = useRef<() => void>(() => {})
  const reloadRef = useRef<() => void>(() => {})
  const peekControlsRef = useRef<{ show: (l: number) => void; hide: () => void } | null>(null)

  // create the editor once
  // follow the app theme (Monaco: hang4r-dark for dark grounds, vs for light)
  const appTheme = useHang4r((s) => s.theme)
  const monacoTheme = isDarkTheme(resolveTheme(appTheme)) ? HANG4R_DARK : 'vs'
  useEffect(() => {
    if (monacoTheme === HANG4R_DARK) ensureTheme() // re-read the active theme's tokens
    monaco.editor.setTheme(monacoTheme)
  }, [monacoTheme, appTheme])

  useEffect(() => {
    if (!hostRef.current) return
    ensureTheme()
    ensureDiagnostics()
    const editor = monaco.editor.create(hostRef.current, {
      value: '',
      language: 'plaintext',
      theme: monacoTheme,
      automaticLayout: true,
      fontSize: useHang4r.getState().editorFontSize,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
      fontLigatures: false,
      letterSpacing: 0,
      // Cursor/VS Code-style minimap (Angel's ask); blocks not characters,
      // so it stays readable at the editor's typical pane widths
      minimap: { enabled: true, maxColumn: 80, renderCharacters: false },
      scrollBeyondLastLine: false,
      glyphMargin: true,
      tabSize: 2,
      // let a dropped OS file bubble to the leaf's drop handler (open it as a tab)
      // instead of Monaco inserting the path/contents as text
      dropIntoEditor: { enabled: false },
      // ⌘+click adds a cursor; that frees ⌥ (alt) for go-to-definition — Angel's
      // preferred gesture. Without this, ⌥+click is Monaco's multi-cursor and
      // fights our go-to-def handler.
      multiCursorModifier: 'ctrlCmd'
    })
    editorRef.current = editor

    // ---- inline git-gutter peek: an inline diff of the hunk + toolbar
    //      (click a change bar → see the removed/added lines right here, like Cursor) ----
    const mkBtn = (label: string, title: string, extra: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.className = 'git-peek-btn ' + extra
      b.onmousedown = (ev) => ev.preventDefault()
      b.onclick = (ev) => {
        ev.stopPropagation()
        onClick()
      }
      return b
    }
    const gotoChange = (dir: number): void => {
      const arr = changedLinesRef.current
      if (!arr.length) return
      const cur = peekLineRef.current
      const next =
        dir > 0
          ? (arr.find((l) => l > cur) ?? arr[0])
          : ([...arr].reverse().find((l) => l < cur) ?? arr[arr.length - 1])
      showPeek(next)
    }
    const afterGit = (): void => {
      applyGutterRef.current()
      useHang4r.getState().bumpGit()
    }
    const toolbarButtons = (): HTMLButtonElement[] => [
      mkBtn('↑', 'Previous change (⇧⌘↑)', '', () => gotoChange(-1)),
      mkBtn('↓', 'Next change (⇧⌘↓)', '', () => gotoChange(1)),
      mkBtn('+', 'Stage this change', 'git-peek-stage', () => {
        const { sessionId: sid, path: pth } = metaRef.current
        void window.hang4r.stageHunkAt(sid, pth, peekLineRef.current).then(afterGit)
        hidePeek()
      }),
      mkBtn('⟲', 'Revert this change', 'git-peek-revert', () => {
        const { sessionId: sid, path: pth } = metaRef.current
        void window.hang4r.revertHunkAt(sid, pth, peekLineRef.current).then(() => {
          reloadRef.current()
          afterGit()
        })
        hidePeek()
      }),
      mkBtn('⧉', 'Open in the Diff panel', '', () => {
        const { sessionId: sid, path: pth } = metaRef.current
        const store = useHang4r.getState()
        store.focusSession(sid)
        store.openDiffFor(sid, pth)
        hidePeek()
      }),
      mkBtn('×', 'Close (Esc)', '', () => hidePeek())
    ]
    // parse a single-hunk unified patch into its new-file start + diff rows
    const parseHunk = (
      patch: string
    ): { newStart: number; rows: { kind: 'ctx' | 'add' | 'del'; text: string }[] } => {
      const rows: { kind: 'ctx' | 'add' | 'del'; text: string }[] = []
      let newStart = 1
      for (const raw of patch.split('\n')) {
        if (raw.startsWith('@@')) {
          const m = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
          if (m) newStart = Number(m[1])
          continue
        }
        if (/^(diff |index |--- |\+\+\+ |\\)/.test(raw)) continue
        if (raw.startsWith('+')) rows.push({ kind: 'add', text: raw.slice(1) })
        else if (raw.startsWith('-')) rows.push({ kind: 'del', text: raw.slice(1) })
        else if (raw.startsWith(' ')) rows.push({ kind: 'ctx', text: raw.slice(1) })
      }
      return { newStart, rows }
    }
    let zoneId: string | null = null
    // true only while a git-peek zone is open — gates the Esc command below so it
    // doesn't shadow Monaco's built-in Escape (close suggest widget, collapse
    // multi-cursor, dismiss hover). Angel: couldn't Esc-dismiss the autocomplete.
    const peekOpenKey = editor.createContextKey<boolean>('hang4rPeekOpen', false)
    const clearZone = (): void => {
      if (zoneId !== null) {
        const z = zoneId
        editor.changeViewZones((a) => a.removeZone(z))
        zoneId = null
      }
      peekOpenKey.set(false)
    }
    const showPeek = (line: number): void => {
      peekLineRef.current = line
      clearZone()
      const { sessionId: sid, path: pth } = metaRef.current
      void window.hang4r.hunkAt(sid, pth, line).then((patch) => {
        if (peekLineRef.current !== line) return // superseded by another click
        const parsed = patch ? parseHunk(patch) : null
        const rows = parsed?.rows ?? []
        const zone = document.createElement('div')
        zone.className = 'git-peek-zone'
        const head = document.createElement('div')
        head.className = 'git-peek-zone-head'
        const title = document.createElement('span')
        title.className = 'git-peek-title'
        title.textContent = `${pth.split('/').pop()} — Git local changes`
        const bar = document.createElement('span')
        bar.className = 'git-peek'
        bar.append(...toolbarButtons())
        head.append(title, bar)
        const body = document.createElement('div')
        body.className = 'git-peek-body'
        if (!rows.length) {
          const d = document.createElement('div')
          d.className = 'git-peek-line git-peek-ctx'
          d.textContent = '  (new file — no previous content)'
          body.append(d)
        }
        for (const r of rows) {
          const d = document.createElement('div')
          d.className = 'git-peek-line git-peek-' + r.kind
          d.textContent = (r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  ') + r.text
          body.append(d)
        }
        zone.append(head, body)
        const height = 1 + Math.min(Math.max(rows.length, 1), 18) + 1
        editor.changeViewZones((a) => {
          zoneId = a.addZone({
            afterLineNumber: Math.max(0, (parsed?.newStart ?? line) - 1),
            heightInLines: height,
            domNode: zone
          })
        })
        peekOpenKey.set(true)
        editor.revealLineInCenterIfOutsideViewport(line)
      })
    }
    const hidePeek = (): void => clearZone()
    peekControlsRef.current = { show: showPeek, hide: hidePeek }
    // Esc closes the peek — but ONLY while a peek is open (the 3rd arg is the
    // when-clause). Without it, this shadowed Monaco's default Escape and broke
    // dismissing the suggest widget / collapsing multi-cursor / closing hover.
    editor.addCommand(monaco.KeyCode.Escape, () => hidePeek(), 'hang4rPeekOpen')
    // click a change bar in the gutter → open the inline peek at that line
    editor.onMouseDown((e) => {
      const t = e.target.type
      const inGutter =
        t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        t === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      const line = e.target.position?.lineNumber
      if (inGutter && line && changedLinesRef.current.includes(line)) {
        showPeek(line)
      } else if (!(e.target.element?.closest('.git-peek-zone'))) {
        hidePeek()
      }
    })
    editor.onDidChangeModelContent(() => {
      const key = dirtyKeyRef.current
      const m = editor.getModel()
      // dirty only if we've moved OFF the saved version — ⌘Z back to it is clean.
      // If we have no saved baseline yet (untitled), any content is dirty.
      const saved = savedVersionMemo.get(key)
      const clean = saved !== undefined && !!m && m.getAlternativeVersionId() === saved
      setDirty(!clean)
      setSharedDirty(key, !clean)
      setPreviewText(editor.getValue())
    })
    editor.onDidChangeCursorSelection((e) => setHasSel(!e.selection.isEmpty()))
    editor.addAction({
      id: 'hang4r.addToChat',
      label: 'Add selection to chat',
      contextMenuGroupId: 'navigation',
      run: (ed) => {
        const sel = ed.getSelection()
        const model = ed.getModel()
        if (!sel || !model) return
        const text = model.getValueInRange(sel)
        if (text.trim()) {
          addRef.current(
            `${path.split('/').pop()} L${sel.startLineNumber}-${sel.endLineNumber}`,
            `${path}:${sel.startLineNumber}-${sel.endLineNumber}\n${text}`
          )
        }
      }
    })
    // route ⌘S/⇧⌘S to the FOCUSED editor's save — the handler that Monaco runs is
    // the last-registered one (shared keybinding service), so always dereference
    // the active refs, which onDidFocusEditorText below keeps pointing at the
    // editor that has focus (falls back to this instance before any focus event)
    editor.onDidFocusEditorText(() => {
      activeSaveRef = doSaveRef
      activeSaveAsRef = doSaveAsRef
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void (activeSaveRef ?? doSaveRef).current()
    })
    // ⌘⇧S — Save As (prompt for a path, write the buffer there, retarget the tab)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
      void (activeSaveAsRef ?? doSaveAsRef).current()
    })
    // ⌘F → open OUR find bar, not Monaco's built-in widget. Registering the
    // command binds ⌘F ahead of the default `actions.find` keybinding; Monaco
    // eats the key before any window-level handler, so this IS the routing.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => openFindRef.current())

    // ---- macOS IDE navigation/editing keys (⌘←/→ line, ⌘↑/↓ doc, ⌘D, ⌃⌘↑/↓) ----
    // Registered ONCE globally (not per-editor) so they dispatch to the FOCUSED
    // editor regardless of how many files are open — see ensureIdeNavKeybindings.
    ensureIdeNavKeybindings()

    // Cmd/Ctrl-click: an import/path string → open that file; otherwise treat the
    // identifier under the cursor as a symbol and jump to its definition.
    const goToPos = async (pos: monaco.Position, model: monaco.editor.ITextModel): Promise<void> => {
      const { sessionId: sid, path: pth, cwd: root } = metaRef.current
      const spec = quotedStringAt(model.getLineContent(pos.lineNumber), pos.column)
      if (spec) {
        const resolved = await window.hang4r.resolveImport(sid, pth, spec)
        if (resolved) {
          useHang4r.getState().requestOpenFile(sid, resolved)
          return
        }
        // an alias/package import (@app/*, nx package) doesn't resolve to a path —
        // don't dead-end; best-effort git-grep on the last path segment
        const seg = spec.split('/').pop()?.replace(/\.[a-z]+$/i, '')
        if (seg) {
          const d = await window.hang4r.findDefinition(sid, seg)
          if (d) useHang4r.getState().requestOpenFile(sid, d.path, d.line)
        }
        return
      }
      const word = model.getWordAtPosition(pos)
      if (!word) return
      // Semantic definition via the TS worker (relative/loaded files, type-aware),
      // BOUNDED so a busy/indexing worker never hangs the click — then git-grep,
      // which needs no worker and scales to any repo (the monorepo's alias/library
      // symbols never resolve in the in-browser worker anyway — Angel).
      if (root && model.uri.scheme === 'file') {
        const def = await Promise.race([
          tsDefinition(model.uri, model.getOffsetAt(pos), root),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200))
        ])
        if (def) {
          useHang4r.getState().requestOpenFile(sid, def.rel, def.line)
          return
        }
      }
      // fallback: git-grep declaration finder (alias/library symbols, worker busy)
      const def = await window.hang4r.findDefinition(sid, word.word)
      if (def) useHang4r.getState().requestOpenFile(sid, def.path, def.line)
    }
    // ⌥ (alt) + click → go to definition (Angel's chosen gesture; ⌘+click is
    // multi-cursor). ⌥+hover underlines the symbol so you know it's navigable.
    editor.onMouseDown((e) => {
      if (!e.event.altKey) return
      const pos = e.target.position
      const model = editor.getModel()
      if (pos && model) void goToPos(pos, model)
    })
    let gotoDeco: string[] = []
    const clearGotoDeco = (): void => {
      if (gotoDeco.length) gotoDeco = editor.deltaDecorations(gotoDeco, [])
    }
    editor.onMouseMove((e) => {
      if (!e.event.altKey) return clearGotoDeco()
      const pos = e.target.position
      const model = editor.getModel()
      const word = pos && model ? model.getWordAtPosition(pos) : null
      if (!pos || !word) return clearGotoDeco()
      gotoDeco = editor.deltaDecorations(gotoDeco, [
        {
          range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn),
          options: { inlineClassName: 'hang4r-goto-link' }
        }
      ])
    })
    editor.onMouseLeave(() => clearGotoDeco())
    // clear the underline the instant ⌥ is released (without needing a mouse move)
    editor.onKeyUp((e) => {
      if (e.keyCode === monaco.KeyCode.Alt) clearGotoDeco()
    })
    // F12 — Go to Definition
    editor.addCommand(monaco.KeyCode.F12, () => {
      const pos = editor.getPosition()
      const model = editor.getModel()
      if (pos && model) void goToPos(pos, model)
    })
    editor.addAction({
      id: 'hang4r.goToDefinition',
      label: 'Go to Definition',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: (ed) => {
        const pos = ed.getPosition()
        const model = ed.getModel()
        if (pos && model) void goToPos(pos, model)
      }
    })
    return () => {
      // persist scroll/cursor/selection so a remount (workspace re-split) restores it
      const key = viewStateKeyRef.current
      if (key) {
        const viewState = editor.saveViewState()
        if (viewState) viewStateMemo.set(key, viewState)
      }
      // don't leave ⌘S pointing at a disposed editor's save
      if (activeSaveRef === doSaveRef) activeSaveRef = null
      if (activeSaveAsRef === doSaveAsRef) activeSaveAsRef = null
      editor.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // load file when the path changes. When we know the workspace root, back the
  // editor with a file-URI model so the TS language service resolves this file
  // as part of the project (cross-file defs/hover); otherwise fall back to the
  // plain reused model.
  useEffect(() => {
    // untitled buffer: no disk read — the editor's fresh empty in-memory model
    // (created at startup, plaintext, editable) IS the buffer. ⌘S names + writes.
    if (path.startsWith('untitled:')) {
      viewStateKeyRef.current = `${sessionId}:${path}`
      setTruncated(false)
      setLoadError(false)
      setDirty(sharedDirty.get(`${sessionId}:${path}`) ?? false)
      return
    }
    setLoadError(false)
    let cancelled = false
    void window.hang4r.readFile(sessionId, path).then((res) => {
      const editor = editorRef.current
      if (cancelled || !editor) return
      const key = `${sessionId}:${path}`
      previewFallbackDone.delete(key) // read OK now → allow a future fallback again
      // switching files (not the initial load into a fresh editor) — save the
      // outgoing file's view state before the model underneath it changes
      if (viewStateKeyRef.current && viewStateKeyRef.current !== key) {
        const outgoing = editor.saveViewState()
        if (outgoing) viewStateMemo.set(viewStateKeyRef.current, outgoing)
      }
      const docDirty = sharedDirty.get(key) ?? false
      if (cwd) {
        const model = ensureModel(cwd, path, res.content, langForPath(path))
        // an unsaved shared model must survive a remount (split/unsplit) —
        // only refresh from disk when the doc is clean
        if (!docDirty && model.getValue() !== res.content) model.setValue(res.content)
        if (editor.getModel() !== model) {
          const prev = editor.getModel()
          editor.setModel(model)
          // dispose the throwaway inmemory model Monaco auto-created at startup
          if (prev && prev.uri.scheme !== 'file') prev.dispose()
        }
        void loadProject(sessionId, cwd) // background — enables cross-file defs
      } else {
        const model = editor.getModel()
        if (model) {
          monaco.editor.setModelLanguage(model, langForPath(path))
          if (!docDirty) model.setValue(res.content)
        }
      }
      viewStateKeyRef.current = key
      const savedViewState = viewStateMemo.get(key)
      if (savedViewState) editor.restoreViewState(savedViewState)
      setTruncated(res.truncated)
      // a clean load == the model now holds disk content: capture it as the saved
      // baseline so a later edit-then-⌘Z reads as clean (bug fix — Angel)
      if (!docDirty) {
        const v = editor.getModel()?.getAlternativeVersionId()
        if (v !== undefined) savedVersionMemo.set(key, v)
      }
      setDirty(docDirty)
      setPreviewText(docDirty ? (editor.getModel()?.getValue() ?? res.content) : res.content)
      void applyGutter()
    }).catch(() => {
      // the read failed — the file is gone/unreadable (readFile now reads any
      // absolute/~ path directly, so a READABLE out-of-tree file never reaches
      // here). Show a quiet inline notice in the editor bar, never a modal.
      // Guarded so a tab remount on a panel switch can't re-trigger anything.
      if (cancelled) return
      const key = `${sessionId}:${path}`
      if (previewFallbackDone.has(key)) return
      previewFallbackDone.add(key)
      setLoadError(true)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, path, cwd])

  // an explicit open (⌘P quick-open, a clicked link, or go-to-definition) must
  // FOCUS this editor — not only when it carries a line. Without the focus, the
  // editor stayed inactive after a ⌘P open, so ⌘F routed to the chat find bar
  // (App.tsx only lets Monaco keep ⌘F when a `.monaco-editor` is focused) and
  // ⌘-click go-to-definition needed a throwaway focus-click first (Angel). Reveal
  // the target line too when there is one. Focus fires once per open (nonce-
  // guarded, module-level) so a session-switch remount doesn't yank focus back.
  const fileToOpen = useHang4r((s) => s.fileToOpen)
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !fileToOpen) return
    if (fileToOpen.sessionId !== sessionId || fileToOpen.path !== path) return
    const { line, nonce } = fileToOpen
    // wait a tick so the model content is loaded before revealing/focusing
    const t = setTimeout(() => {
      const ed = editorRef.current
      if (!ed) return
      if (line) {
        ed.revealLineInCenter(line)
        ed.setPosition({ lineNumber: line, column: 1 })
      }
      if (!focusedOpenNonces.has(nonce)) {
        focusedOpenNonces.add(nonce)
        ed.focus()
      }
    }, 60)
    return () => clearTimeout(t)
  }, [fileToOpen, sessionId, path])

  // git dirty-diff bars in the editor gutter (added/modified/deleted vs HEAD)
  const gitNonce = useHang4r((s) => s.gitNonce)
  const gutterRef = useRef<string[]>([])
  const applyGutter = useCallback(async (): Promise<void> => {
    const editor = editorRef.current
    if (!editor) return
    const st = await window.hang4r.gitLineStatus(sessionId, path).catch(() => null)
    if (!st || !editorRef.current) return
    const ruler = monaco.editor.OverviewRulerLane.Left
    const decos: monaco.editor.IModelDeltaDecoration[] = []
    const add = (lines: number[], cls: string, color: string): void => {
      for (const l of lines) {
        decos.push({
          range: new monaco.Range(l, 1, l, 1),
          options: {
            isWholeLine: false,
            linesDecorationsClassName: cls,
            overviewRuler: { color, position: ruler }
          }
        })
      }
    }
    add(st.added, 'gutter-added', cssToken('--green', '#66bd7e'))
    add(st.modified, 'gutter-modified', '#42a5f5')
    add(st.deleted, 'gutter-deleted', cssToken('--red', '#d97070'))
    gutterRef.current = editor.deltaDecorations(gutterRef.current, decos)
    changedLinesRef.current = [...st.added, ...st.modified, ...st.deleted].sort((a, b) => a - b)
    // if the peeked line is no longer a change (e.g. after revert), close the peek
    if (peekLineRef.current && !changedLinesRef.current.includes(peekLineRef.current)) {
      peekControlsRef.current?.hide()
    }
  }, [sessionId, path])
  applyGutterRef.current = () => void applyGutter()
  const reloadFromDisk = useCallback((): void => {
    if (dirtyRef.current || sharedDirty.get(dirtyKeyRef.current)) return // don't clobber unsaved edits
    void window.hang4r.readFile(sessionId, path).then((res) => {
      const model = editorRef.current?.getModel()
      if (model) model.setValue(res.content)
      setDirty(false)
      setPreviewText(res.content)
    })
  }, [sessionId, path])
  reloadRef.current = reloadFromDisk
  useEffect(() => {
    void applyGutter()
  }, [applyGutter, gitNonce])

  // write the current buffer to a NEW relative path (untitled save, or Save As),
  // then hand this tab off to that path via onSavedAs. Returns false if the user
  // cancelled the name prompt.
  const promptSaveAs = async (): Promise<boolean> => {
    const editor = editorRef.current
    if (!editor) return false
    const name = await useHang4r
      .getState()
      .showPrompt('Save as (path relative to project root):', isUntitled ? '' : path)
    if (!name?.trim()) return false
    const rel = name.trim()
    try {
      await window.hang4r.createFile(sessionId, rel) // creates parent dirs + the file
    } catch {
      /* already exists → we overwrite with writeFile below */
    }
    await window.hang4r.writeFile(sessionId, rel, editor.getValue())
    setSharedDirty(`${sessionId}:${path}`, false)
    setDirty(false)
    useHang4r.getState().bumpGit()
    onSavedAsRef.current?.(path, rel)
    return true
  }
  const doSave = async (): Promise<void> => {
    const editor = editorRef.current
    if (!editor || truncated) return
    if (isUntitled) {
      await promptSaveAs()
      return
    }
    setSaving(true)
    try {
      await window.hang4r.writeFile(sessionId, path, editor.getValue())
      setDirty(false)
      setSharedDirty(dirtyKeyRef.current, false)
      const v = editor.getModel()?.getAlternativeVersionId()
      if (v !== undefined) savedVersionMemo.set(dirtyKeyRef.current, v) // new saved baseline
      void applyGutter()
      useHang4r.getState().bumpGit()
    } finally {
      setSaving(false)
    }
  }
  const doSaveAs = async (): Promise<void> => {
    await promptSaveAs()
  }
  doSaveRef.current = doSave
  doSaveAsRef.current = doSaveAs
  promptSaveAsRef.current = promptSaveAs

  // expose a save handle so the parent can auto-flush unsaved changes on close
  useEffect(() => {
    onRegister?.(path, {
      isDirty: () => dirtyRef.current,
      save: async () => {
        // untitled buffer: name + write (never writeFile to the `untitled:` path)
        if (path.startsWith('untitled:')) {
          await promptSaveAsRef.current()
          return
        }
        const editor = editorRef.current
        if (editor && !truncated) {
          await window.hang4r.writeFile(sessionId, path, editor.getValue())
          setSharedDirty(`${sessionId}:${path}`, false)
          const v = editor.getModel()?.getAlternativeVersionId()
          if (v !== undefined) savedVersionMemo.set(`${sessionId}:${path}`, v)
        }
      },
      discard: () => {
        setSharedDirty(`${sessionId}:${path}`, false)
        setDirty(false)
        // discard reverts to disk content elsewhere; treat current as the baseline
        const v = editorRef.current?.getModel()?.getAlternativeVersionId()
        if (v !== undefined) savedVersionMemo.set(`${sessionId}:${path}`, v)
      }
    })
    return () => onRegister?.(path, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, sessionId, truncated])

  const addSelection = (): void => {
    const editor = editorRef.current
    const sel = editor?.getSelection()
    const model = editor?.getModel()
    if (!editor || !sel || !model || sel.isEmpty()) return
    const text = model.getValueInRange(sel)
    addRef.current(
      `${path.split('/').pop()} L${sel.startLineNumber}-${sel.endLineNumber}`,
      `${path}:${sel.startLineNumber}-${sel.endLineNumber}\n${text}`
    )
  }

  return (
    <div className="code-editor" ref={rootRef}>
      {/* ⌘F in the rendered MARKDOWN preview searches the PREVIEW DOM (same
          Custom-Highlight find as the chat), not the hidden Monaco source —
          otherwise it counted matches you couldn't see/scroll to (Angel). The
          HTML preview is a <webview> (separate context) so it stays on Monaco. */}
      {findOpen && previewable && previewMode && kind === 'markdown' ? (
        <ChatFindBar
          containerRef={previewRef}
          placeholder="Find in preview"
          focusToken={findToken}
          onClose={() => setFindOpen(false)}
        />
      ) : (
        findOpen &&
        editorRef.current && (
          <EditorFindBar
            editor={editorRef.current}
            focusToken={findToken}
            onClose={() => {
              setFindOpen(false)
              editorRef.current?.focus()
            }}
          />
        )
      )}
      <div className="code-editor-bar">
        <span className="code-editor-path">
          {isUntitled ? 'Untitled-' + path.slice('untitled:'.length) : path}
          {dirty && <span className="code-editor-dot" title="Unsaved changes">●</span>}
        </span>
        {truncated && <span className="files-truncated">large file — read-only</span>}
        {loadError && (
          <span className="files-truncated" title={path}>
            couldn&apos;t open — file may have moved or its worktree was removed
          </span>
        )}
        {hasSel && (
          <button className="ghost-btn code-editor-addchat" onClick={addSelection}>
            ↳ Add to chat
          </button>
        )}
        {previewable && (
          <div className="preview-source-tabs" role="tablist" aria-label="Preview or source">
            <button
              type="button"
              role="tab"
              aria-selected={previewMode}
              className={'preview-source-tab' + (previewMode ? ' preview-source-tab-active' : '')}
              onClick={() => setPreviewMode(true)}
            >
              {kind === 'csv' ? 'Table' : 'Preview'}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!previewMode}
              className={'preview-source-tab' + (!previewMode ? ' preview-source-tab-active' : '')}
              onClick={() => setPreviewMode(false)}
            >
              Source
            </button>
          </div>
        )}
        {!isUntitled && (
          <button
            className="ghost-btn code-editor-reveal"
            title="Reveal in Finder"
            onClick={() => void window.hang4r.revealInFinder(sessionId, path)}
          >
            Reveal in Finder
          </button>
        )}
        <button
          className="primary-btn code-editor-save"
          disabled={!dirty || saving || truncated}
          onClick={() => void doSave()}
        >
          {saving ? 'Saving…' : 'Save ⌘S'}
        </button>
      </div>
      <div
        className="code-editor-host"
        ref={hostRef}
        style={previewable && previewMode ? { display: 'none' } : undefined}
      />
      {previewable && previewMode && (
        <div
          ref={previewRef}
          // Focusable on purpose. Rendered markdown is not, so clicking it drops
          // focus to <body> — which focusPane() reads as "the conversation", and
          // ⌘W then closed the whole SESSION instead of the file, and ⌘N opened
          // the new-agent dialog instead of an untitled file (Angel). Monaco
          // takes focus for the source side; the preview has to do the same.
          tabIndex={0}
          className={
            'code-editor-preview' +
            (kind === 'html' ? ' code-editor-preview-html' : '') +
            (kind === 'csv' ? ' code-editor-preview-csv' : '')
          }
        >
          {kind === 'markdown' ? (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(sessionId, path)}>{previewText}</ReactMarkdown>
            </div>
          ) : kind === 'csv' ? (
            <CsvTable text={previewText} />
          ) : previewSrc ? (
            <webview
              // eslint-disable-next-line react/no-unknown-property
              src={previewSrc}
              partition="persist:hang4r-preview"
              className="html-preview-webview"
            />
          ) : null}
        </div>
      )}
    </div>
  )
}
