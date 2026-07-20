import * as monaco from 'monaco-editor'

/**
 * Loads a workspace's JS/TS sources into Monaco as file-URI models so the
 * bundled TypeScript language service can resolve go-to-definition and hover
 * across files (not just the single open buffer). Falls back gracefully — the
 * editor's git-grep definition finder still runs when the service returns nothing.
 */

const SRC = /\.(ts|tsx|js|jsx|mjs|cjs)$/i
const loadedCwds = new Set<string>()

const trimRoot = (p: string): string => p.replace(/\/+$/, '')

/** the file:// URI Monaco uses for a workspace-relative path */
export function fileUri(cwd: string, rel: string): monaco.Uri {
  return monaco.Uri.file(`${trimRoot(cwd)}/${rel}`)
}

/** get-or-create the shared model for a path (reused by editor + project) */
export function ensureModel(
  cwd: string,
  rel: string,
  content: string,
  language?: string
): monaco.editor.ITextModel {
  const uri = fileUri(cwd, rel)
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, language, uri)
}

/** load every source file in the workspace as a model, once per cwd (background) */
export async function loadProject(sessionId: string, cwd: string): Promise<void> {
  if (!cwd || loadedCwds.has(cwd)) return
  loadedCwds.add(cwd)
  try {
    const files = await window.hang4r.readSources(sessionId)
    for (const f of files) {
      if (!SRC.test(f.path)) continue
      const uri = fileUri(cwd, f.path)
      if (!monaco.editor.getModel(uri)) monaco.editor.createModel(f.content, undefined, uri)
    }
  } catch {
    loadedCwds.delete(cwd) // allow a later retry
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Semantic definition for the symbol at `offset` in `uri`, via the TS worker.
 * Returns a workspace-relative target (rel + 1-based line) or null (non-symbol,
 * outside the workspace, or the service isn't ready yet).
 */
export async function tsDefinition(
  uri: monaco.Uri,
  offset: number,
  cwd: string
): Promise<{ rel: string; line: number } | null> {
  const ts = (monaco.languages as any).typescript
  const isTs = /\.(ts|tsx)$/i.test(uri.path)
  const getWorker = isTs ? ts?.getTypeScriptWorker : ts?.getJavaScriptWorker
  if (typeof getWorker !== 'function') return null
  try {
    const client = await (await getWorker())(uri)
    const defs = await client.getDefinitionAtPosition(uri.toString(), offset)
    if (!defs?.length) return null
    // prefer a definition in a different file (a real cross-file jump)
    const d = defs.find((x: any) => x.fileName !== uri.toString()) ?? defs[0]
    const target = monaco.Uri.parse(d.fileName)
    const abs = target.fsPath
    const root = trimRoot(cwd)
    if (!abs.startsWith(root + '/')) return null // node_modules / lib.d.ts — not openable here
    const model = monaco.editor.getModel(target)
    const line = model ? model.getPositionAt(d.textSpan.start).lineNumber : 1
    return { rel: abs.slice(root.length + 1), line }
  } catch {
    return null
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
