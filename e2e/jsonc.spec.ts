import { test, expect } from '@playwright/test'
import { stripJsonComments, hasJsonComments, patchJsonc } from '../src/shared/jsonc'

/**
 * Unit coverage for the JSONC comment stripper that backs every settings-file
 * parse (SettingsService.readFile / writeRaw, the in-app editor's fail-fast
 * validate). It launches no app — pure logic. The load-bearing property: real
 * `//` and block comments are removed, but `//` and comment-looking bytes that
 * live INSIDE a JSON string value survive untouched.
 */
test.describe('stripJsonComments', () => {
  test('removes line comments but the stripped text still parses to the same value', () => {
    const jsonc = `{
  // default model for this backend
  "agents": { "claude": { "model": "haiku" } }, // trailing note
  "worktreeDir": ".hang4r-worktrees"
}`
    const stripped = stripJsonComments(jsonc)
    expect(stripped).not.toContain('default model')
    expect(stripped).not.toContain('trailing note')
    expect(JSON.parse(stripped)).toEqual({
      agents: { claude: { model: 'haiku' } },
      worktreeDir: '.hang4r-worktrees'
    })
  })

  test('a "//" inside a string value is preserved (not treated as a comment)', () => {
    const jsonc = `{
  // this is a real comment and must go
  "url": "https://example.com//path",
  "cmd": "echo // not a comment",
  "escaped": "a \\" quote then // still a string"
}`
    const parsed = JSON.parse(stripJsonComments(jsonc))
    expect(parsed.url).toBe('https://example.com//path')
    expect(parsed.cmd).toBe('echo // not a comment')
    expect(parsed.escaped).toBe('a " quote then // still a string')
  })

  test('handles /* block */ comments, including across lines', () => {
    const jsonc = `{
  /* block comment
     spanning lines */
  "a": 1,
  "b": 2 /* inline */
}`
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ a: 1, b: 2 })
  })

  test('is a no-op on comment-free JSON and reports comment presence', () => {
    const plain = '{\n  "a": 1\n}'
    expect(stripJsonComments(plain)).toBe(plain)
    expect(hasJsonComments(plain)).toBe(false)
    expect(hasJsonComments('{ "a": 1 } // note')).toBe(true)
  })
})

/**
 * Unit coverage for the comment-preserving text-level patcher that backs the
 * Settings UI's structured saves. Also app-free. The load-bearing property:
 * setting one dotted-path key rewrites ONLY that key's value span (or inserts
 * just that key), leaving every comment and untouched byte verbatim — and the
 * result still parses (via stripJsonComments) to the expected value.
 */
test.describe('patchJsonc', () => {
  /** Every `//`-comment line of `text` must appear verbatim in `patched`. */
  const commentLines = (text: string): string[] =>
    text.split('\n').filter((l) => l.trim().startsWith('//'))

  test('replaces an existing top-level value, keeping comments above and beside it', () => {
    const src = `{
  // the visual theme
  "theme": "dark", // trailing note
  "editorFontSize": 14
}`
    const out = patchJsonc(src, ['theme'], 'light')
    expect(out).toContain('// the visual theme')
    expect(out).toContain('// trailing note')
    expect(JSON.parse(stripJsonComments(out))).toEqual({ theme: 'light', editorFontSize: 14 })
    // untouched key's formatting is byte-identical
    expect(out).toContain('"editorFontSize": 14')
  })

  test('replaces a nested value (agents.claude.model) without disturbing siblings', () => {
    const src = `{
  "agents": {
    // per-backend defaults
    "claude": { "model": "opus" },
    "codex": { "model": "gpt-5" }
  }
}`
    const out = patchJsonc(src, ['agents', 'claude', 'model'], 'haiku')
    expect(out).toContain('// per-backend defaults')
    expect(JSON.parse(stripJsonComments(out))).toEqual({
      agents: { claude: { model: 'haiku' }, codex: { model: 'gpt-5' } }
    })
  })

  test('inserts a new leaf into an existing object after its last property', () => {
    const src = `{
  "binaries": {
    // path overrides
    "claude": "/opt/claude"
  }
}`
    const out = patchJsonc(src, ['binaries', 'codex'], '/opt/codex')
    expect(out).toContain('// path overrides')
    expect(out).toContain('"claude": "/opt/claude"')
    expect(JSON.parse(stripJsonComments(out))).toEqual({
      binaries: { claude: '/opt/claude', codex: '/opt/codex' }
    })
  })

  test('inserts a whole missing nested chain into the root object', () => {
    const src = `{
  // only a theme so far
  "theme": "dark"
}`
    const out = patchJsonc(src, ['notifications', 'onError'], false)
    expect(out).toContain('// only a theme so far')
    expect(JSON.parse(stripJsonComments(out))).toEqual({
      theme: 'dark',
      notifications: { onError: false }
    })
  })

  test('inserts into a totally empty object', () => {
    expect(JSON.parse(stripJsonComments(patchJsonc('{}\n', ['theme'], 'dark')))).toEqual({
      theme: 'dark'
    })
    expect(
      JSON.parse(stripJsonComments(patchJsonc('{}', ['agents', 'claude', 'model'], 'opus')))
    ).toEqual({ agents: { claude: { model: 'opus' } } })
  })

  test('array values (devProcesses) round-trip and re-indent to the insertion depth', () => {
    const src = `{
  // workspace overrides
  "worktreeDir": ".wt"
}`
    const procs = [
      { name: 'web', command: 'npm run dev' },
      { name: 'api', command: 'go run .' }
    ]
    const out = patchJsonc(src, ['devProcesses'], procs)
    expect(out).toContain('// workspace overrides')
    expect(JSON.parse(stripJsonComments(out))).toEqual({ worktreeDir: '.wt', devProcesses: procs })
    // replacing it again keeps comments and swaps just the array
    const out2 = patchJsonc(out, ['devProcesses'], [{ name: 'web', command: 'echo hi' }])
    expect(out2).toContain('// workspace overrides')
    expect(JSON.parse(stripJsonComments(out2)).devProcesses).toEqual([
      { name: 'web', command: 'echo hi' }
    ])
  })

  test('a comment that looks like "key": value is NOT treated as a real key', () => {
    const src = `{
  // "theme": "should-be-ignored",
  "theme": "dark"
}`
    const out = patchJsonc(src, ['theme'], 'light')
    // the real key changed; the decoy comment is untouched and NOT parsed as data
    expect(out).toContain('// "theme": "should-be-ignored",')
    expect(JSON.parse(stripJsonComments(out))).toEqual({ theme: 'light' })
  })

  test('re-patching is idempotent and preserves every comment line', () => {
    const src = `{
  // a
  "theme": "dark",
  // b
  "editorFontSize": 14
}`
    const once = patchJsonc(src, ['theme'], 'light')
    const twice = patchJsonc(once, ['theme'], 'light')
    expect(twice).toBe(once)
    expect(commentLines(twice)).toEqual(commentLines(src))
  })

  test('deleting a key drops the property but keeps the comment line above it', () => {
    const src = `{
  // keep me
  "theme": "dark",
  "editorFontSize": 14
}`
    const out = patchJsonc(src, ['theme'], undefined)
    expect(out).toContain('// keep me')
    expect(JSON.parse(stripJsonComments(out))).toEqual({ editorFontSize: 14 })

    // deleting the LAST property strips the dangling separator comma too
    const out2 = patchJsonc(src, ['editorFontSize'], undefined)
    expect(JSON.parse(stripJsonComments(out2))).toEqual({ theme: 'dark' })
  })

  test('throws (rather than guess) on a non-object root or descent through a scalar', () => {
    expect(() => patchJsonc('[1, 2, 3]', ['a'], 1)).toThrow()
    expect(() => patchJsonc('{ "theme": "dark" }', ['theme', 'nested'], 1)).toThrow()
  })
})
