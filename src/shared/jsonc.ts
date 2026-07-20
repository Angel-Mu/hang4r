/**
 * Minimal, dependency-free JSONC → JSON stripper.
 *
 * The settings files tolerate `//` line comments and block comments (the
 * per-workspace template ships fully commented) but `JSON.parse` doesn't, so
 * every parse/validate path strips comments first. The scan is string-aware:
 * a `//` or `"..."` sequence *inside* a JSON string value is copied verbatim,
 * only real comments are removed. Comment bytes are replaced with spaces (and
 * newlines kept) so character offsets and line numbers survive for error
 * messages.
 */
export function stripJsonComments(input: string): string {
  let out = ''
  let i = 0
  const n = input.length
  let inString = false

  while (i < n) {
    const c = input[i]

    if (inString) {
      out += c
      if (c === '\\' && i + 1 < n) {
        // copy the escaped character verbatim (handles \" inside a string)
        out += input[i + 1]
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }

    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }

    if (c === '/' && i + 1 < n && input[i + 1] === '/') {
      // line comment → blank it out, keep the newline
      while (i < n && input[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }

    if (c === '/' && i + 1 < n && input[i + 1] === '*') {
      // block comment → blank it out, preserve embedded newlines
      out += '  '
      i += 2
      while (i < n && !(input[i] === '*' && i + 1 < n && input[i + 1] === '/')) {
        out += input[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += '  '
        i += 2 // consume the closing */
      }
      continue
    }

    out += c
    i++
  }

  return out
}

/** True when the text carries any `//` or block comment outside of a string. */
export function hasJsonComments(text: string): boolean {
  return stripJsonComments(text) !== text
}

/* -------------------------------------------------------------------------- *
 * Comment-preserving, text-level JSONC patcher.
 *
 * `patchJsonc` sets (or deletes) one dotted-path key in a JSONC document while
 * leaving every comment and every untouched byte of formatting exactly as it
 * was. The trick is stripJsonComments' offset-preserving property: we strip to
 * a SHADOW copy (comments blanked to spaces, same length, same newlines), scan
 * the shadow with a small string-aware structural walker to locate key/value
 * spans, then splice the edit into the ORIGINAL text at those same offsets.
 *
 * Deliberately in scope (all that the Settings UI's structured saves need):
 *   - replace the value span of an existing full path (any depth), inline;
 *   - insert a missing leaf into an existing ancestor object;
 *   - insert a whole missing nested chain into the root object;
 *   - object/array values, serialized with JSON.stringify(…, 2) and re-indented
 *     to the insertion depth;
 *   - delete a key (value === undefined): drop the property + one adjacent
 *     comma, leaving any comment lines above it (the user's notes) in place.
 *
 * Deliberately OUT of scope (callers must not rely on these):
 *   - a root that is not a single JSON object (throws);
 *   - descending THROUGH a non-object value, or through an array, to reach a
 *     leaf (throws — settings paths never index into arrays);
 *   - preserving intra-value formatting when a value is REPLACED (the new value
 *     is re-serialized canonically; comments beside/above the key are kept).
 *
 * Any internal inconsistency throws rather than guessing; callers validate the
 * result parses and treat a throw as "leave the file untouched".
 * -------------------------------------------------------------------------- */

interface JsoncObject {
  /** offset of the opening `{` */
  start: number
  /** offset of the matching `}` */
  end: number
  props: JsoncProp[]
}

interface JsoncProp {
  key: string
  /** offset of the key's opening `"` */
  keyStart: number
  /** offset of the first byte of the value */
  valueStart: number
  /** offset one past the last byte of the value */
  valueEnd: number
  /** parsed structure when the value is itself an object, else null */
  valueObject: JsoncObject | null
}

function isJsonWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

function skipWs(s: string, i: number): number {
  while (i < s.length && isJsonWs(s[i])) i++
  return i
}

/** s[i] is the opening `"`; returns the offset one past the closing `"`. */
function stringEnd(s: string, i: number): number {
  i++
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '"') return i + 1
    i++
  }
  throw new Error('Unterminated string')
}

/** s[i] is `[` or `{`; returns the offset one past the matching close. */
function bracketEnd(s: string, i: number): number {
  let depth = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '"') {
      i = stringEnd(s, i)
      continue
    }
    if (c === '[' || c === '{') {
      depth++
      i++
      continue
    }
    if (c === ']' || c === '}') {
      depth--
      i++
      if (depth === 0) return i
      continue
    }
    i++
  }
  throw new Error('Unterminated array/object')
}

/** Parse the value starting at (or after whitespace before) offset i. */
function parseValue(s: string, i: number): { end: number; object: JsoncObject | null } {
  i = skipWs(s, i)
  const c = s[i]
  if (c === '{') {
    const object = parseObject(s, i)
    return { end: object.end + 1, object }
  }
  if (c === '[') return { end: bracketEnd(s, i), object: null }
  if (c === '"') return { end: stringEnd(s, i), object: null }
  // scalar (number / true / false / null): read to the next delimiter
  let j = i
  while (j < s.length && !isJsonWs(s[j]) && s[j] !== ',' && s[j] !== '}' && s[j] !== ']') j++
  if (j === i) throw new Error(`Expected a value at offset ${i}`)
  return { end: j, object: null }
}

/** s[i] is the opening `{`; returns its structure (end points AT the `}`). */
function parseObject(s: string, i: number): JsoncObject {
  const start = i
  i = skipWs(s, i + 1)
  const props: JsoncProp[] = []
  if (s[i] === '}') return { start, end: i, props }
  while (i < s.length) {
    i = skipWs(s, i)
    if (s[i] !== '"') throw new Error(`Expected an object key at offset ${i}`)
    const keyStart = i
    const keyEnd = stringEnd(s, i)
    const key = JSON.parse(s.slice(keyStart, keyEnd)) as string
    i = skipWs(s, keyEnd)
    if (s[i] !== ':') throw new Error(`Expected ':' at offset ${i}`)
    const { end, object } = parseValue(s, i + 1)
    props.push({ key, keyStart, valueStart: skipWs(s, i + 1), valueEnd: end, valueObject: object })
    i = skipWs(s, end)
    if (s[i] === ',') {
      i++
      continue
    }
    if (s[i] === '}') return { start, end: i, props }
    throw new Error(`Expected ',' or '}' at offset ${i}`)
  }
  throw new Error('Unterminated object')
}

/** Leading whitespace of the line containing offset `pos`. */
function lineIndentAt(text: string, pos: number): string {
  const ls = text.lastIndexOf('\n', pos) + 1
  let e = ls
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++
  return text.slice(ls, e)
}

/** Re-indent every line after the first by `indent` (first line stays inline). */
function reindent(serialized: string, indent: string): string {
  return serialized
    .split('\n')
    .map((line, idx) => (idx === 0 ? line : indent + line))
    .join('\n')
}

/** Serialize a value for placement whose continuation lines sit at `indent`. */
function serializeValue(value: unknown, indent: string): string {
  if (value !== null && typeof value === 'object') {
    return reindent(JSON.stringify(value, null, 2), indent)
  }
  return JSON.stringify(value)
}

function replaceValue(text: string, prop: JsoncProp, value: unknown): string {
  const serialized = serializeValue(value, lineIndentAt(text, prop.keyStart))
  return text.slice(0, prop.valueStart) + serialized + text.slice(prop.valueEnd)
}

/** Insert `remaining` (a missing key chain) with `value` at its leaf into obj. */
function insertChain(
  text: string,
  obj: JsoncObject,
  remaining: string[],
  value: unknown
): string {
  let nested: unknown = value
  for (let j = remaining.length - 1; j >= 1; j--) nested = { [remaining[j]]: nested }
  const propKey = remaining[0]

  if (obj.props.length > 0) {
    const last = obj.props[obj.props.length - 1]
    const childIndent = lineIndentAt(text, last.keyStart)
    const propText = `${JSON.stringify(propKey)}: ${serializeValue(nested, childIndent)}`
    return text.slice(0, last.valueEnd) + ',\n' + childIndent + propText + text.slice(last.valueEnd)
  }
  // empty object `{}` / `{ }` — open it up onto its own line(s)
  const baseIndent = lineIndentAt(text, obj.start)
  const childIndent = baseIndent + '  '
  const propText = `${JSON.stringify(propKey)}: ${serializeValue(nested, childIndent)}`
  const inner = '\n' + childIndent + propText + '\n' + baseIndent
  return text.slice(0, obj.start + 1) + inner + text.slice(obj.end)
}

/** Remove a property and one adjacent comma; comment lines above it are kept. */
function deleteProp(text: string, shadow: string, obj: JsoncObject, prop: JsoncProp): string {
  const idx = obj.props.indexOf(prop)
  const lineStart = text.lastIndexOf('\n', prop.keyStart) + 1
  const afterValue = skipWs(shadow, prop.valueEnd)

  if (shadow[afterValue] === ',') {
    // not the last property: drop this line through its trailing comma+newline
    const nl = text.indexOf('\n', afterValue)
    const end = nl === -1 ? text.length : nl + 1
    return text.slice(0, lineStart) + text.slice(end)
  }

  // last property: also strip the separator comma left dangling on the prior one
  const nl = text.indexOf('\n', prop.valueEnd)
  const lineEnd = nl === -1 ? text.length : nl + 1
  if (idx > 0) {
    const prevEnd = obj.props[idx - 1].valueEnd
    const commaIdx = shadow.indexOf(',', prevEnd)
    if (commaIdx !== -1 && commaIdx < prop.keyStart) {
      return text.slice(0, commaIdx) + text.slice(commaIdx + 1, lineStart) + text.slice(lineEnd)
    }
  }
  // sole property → the object is left empty
  return text.slice(0, lineStart) + text.slice(lineEnd)
}

/**
 * Set one dotted-path key in a JSONC document, preserving all comments and the
 * formatting of every untouched region. Pass `value === undefined` to delete
 * the key. Throws on any structural surprise (see the file-header scope notes);
 * callers should validate the result parses and, on a throw, leave the file as
 * it was rather than fall back to a comment-dropping rewrite.
 */
export function patchJsonc(text: string, path: string[], value: unknown): string {
  if (path.length === 0) throw new Error('patchJsonc: empty path')
  const shadow = stripJsonComments(text)
  const rootStart = skipWs(shadow, 0)
  if (shadow[rootStart] !== '{') throw new Error('patchJsonc: root is not a JSON object')
  const root = parseObject(shadow, rootStart)
  const deleting = value === undefined

  let obj = root
  for (let i = 0; i < path.length; i++) {
    const part = path[i]
    const prop = obj.props.find((p) => p.key === part)
    const isLeaf = i === path.length - 1
    if (prop) {
      if (isLeaf) {
        return deleting ? deleteProp(text, shadow, obj, prop) : replaceValue(text, prop, value)
      }
      if (!prop.valueObject) {
        throw new Error(
          `patchJsonc: ${path.slice(0, i + 1).join('.')} exists but is not an object`
        )
      }
      obj = prop.valueObject
    } else {
      if (deleting) return text // nothing to delete
      return insertChain(text, obj, path.slice(i), value)
    }
  }
  return text // unreachable — a full-path hit always returns above
}
