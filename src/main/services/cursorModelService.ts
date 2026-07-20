import { spawn } from 'node:child_process'
import type { ModelChoice } from '../../shared/protocol'
import { findBinary } from './binaryDiscovery'

const FALLBACK_CURSOR_MODELS: ModelChoice[] = [{ value: '', label: 'Default model' }]

/**
 * cursor-agent owns its account-aware model catalog. `cursor-agent --list-models`
 * prints plain text — one model per line as `<slug> - <Display Name>` (the first
 * line is a header, `auto` is the default). We parse it into ModelChoices; the
 * 'Default model' entry (empty value → no --model flag → cursor's auto) leads,
 * and the explicit `auto` line is folded into it. Querying keeps hang4r aligned
 * with the installed/logged-in CLI instead of shipping stale slugs.
 */
export class CursorModelService {
  static async list(binaryOverride?: string | null): Promise<ModelChoice[]> {
    const binary = findBinary('cursor-agent', binaryOverride)
    if (!binary) return FALLBACK_CURSOR_MODELS
    try {
      const text = await runListModels(binary)
      const choices = parseCursorModels(text)
      return choices.length ? [{ value: '', label: 'Default model' }, ...choices] : FALLBACK_CURSOR_MODELS
    } catch {
      return FALLBACK_CURSOR_MODELS
    }
  }
}

/** Parse `cursor-agent --list-models` plain-text output into model choices. */
export function parseCursorModels(text: string): ModelChoice[] {
  const choices: ModelChoice[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9][\w.-]*)\s+-\s+(.+?)\s*$/)
    if (!m) continue
    const value = m[1].trim()
    // `auto` is cursor's default — represented by the leading 'Default model'
    if (!value || value === 'auto' || seen.has(value)) continue
    seen.add(value)
    // strip cursor's "(current, default)" / "(NO ZDR)" style annotations from the label
    const label = m[2].replace(/\s*\((?:current|default)[^)]*\)\s*$/i, '').trim() || value
    choices.push({ value, label })
  }
  return choices
}

function runListModels(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ['--list-models'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    let out = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('timed out listing cursor models'))
    }, 15_000)
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr.on('data', () => {})
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 || out.trim()) resolve(out)
      else reject(new Error(`cursor-agent --list-models exited ${code}`))
    })
  })
}
