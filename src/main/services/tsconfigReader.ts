import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'

/**
 * Feed Monaco's in-browser TS worker the project's path aliases so imported
 * symbols resolve to real types instead of `any` (Angel: hover showed
 * `addressService: any`). We only extract baseUrl + paths — the worker already
 * has the source models via loadProject; it just lacks the alias map.
 */

/** JSONC → JSON: strip // and block comments + trailing commas so JSON.parse works */
function parseJsonc(raw: string): Record<string, unknown> {
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  // line comments, but not the // inside a "http://" style string value
  const noLine = noBlock.replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
  const noTrailingComma = noLine.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(noTrailingComma) as Record<string, unknown>
}

type Co = { baseUrl?: string; paths?: Record<string, string[]> }

/** parse one tsconfig file → its compilerOptions subset + the dir it lives in */
function readOne(file: string): { co: Co; dir: string; extends?: string } | null {
  if (!existsSync(file)) return null
  try {
    const cfg = parseJsonc(readFileSync(file, 'utf8'))
    const co = (cfg.compilerOptions as Co) ?? {}
    return {
      co,
      dir: dirname(file),
      extends: typeof cfg.extends === 'string' ? cfg.extends : undefined
    }
  } catch {
    return null
  }
}

/**
 * baseUrl (ABSOLUTE, so it matches the file:// model URIs the worker sees) +
 * paths for a project, resolving one level of `extends` (nx keeps the aliases in
 * tsconfig.base.json). Returns null when there's nothing useful (no paths) or on
 * any parse error — the caller then just leaves types as-is, never worse.
 */
export function readProjectTsconfig(
  root: string
): { baseUrl: string; paths: Record<string, string[]> } | null {
  try {
    const entry = readOne(join(root, 'tsconfig.json'))
    if (!entry) return null

    // whichever config supplies baseUrl/paths — the child wins, else the extended
    // base (skip package/node_modules extends, which we can't resolve on disk here)
    let baseUrl = entry.co.baseUrl
    let baseUrlDir = entry.dir
    let paths = entry.co.paths

    if (
      entry.extends &&
      !entry.extends.startsWith('@') &&
      !entry.extends.includes('node_modules')
    ) {
      const rel = entry.extends.endsWith('.json') ? entry.extends : `${entry.extends}.json`
      const base = readOne(resolve(entry.dir, rel))
      if (base) {
        if (baseUrl === undefined && base.co.baseUrl !== undefined) {
          baseUrl = base.co.baseUrl
          baseUrlDir = base.dir
        }
        if (paths === undefined && base.co.paths) paths = base.co.paths
      }
    }

    if (!paths || typeof paths !== 'object' || Object.keys(paths).length === 0) return null
    const rel = baseUrl ?? '.'
    return { baseUrl: isAbsolute(rel) ? rel : resolve(baseUrlDir, rel), paths }
  } catch {
    return null
  }
}
