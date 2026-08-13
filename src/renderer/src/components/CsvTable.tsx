import { useMemo, type JSX } from 'react'

/**
 * Parse CSV/TSV text into rows of fields. Handles quoted fields, escaped quotes
 * (""), and commas/newlines embedded inside quotes — a naive `split(',')` mangles
 * exactly the kind of address/phone data Angel opens. Delimiter is auto-detected
 * (tab vs comma) from the first line.
 */
function parseDelimited(text: string): string[][] {
  const nl = text.indexOf('\n')
  const first = nl === -1 ? text : text.slice(0, nl)
  const tabs = (first.match(/\t/g) ?? []).length
  const commas = (first.match(/,/g) ?? []).length
  const delim = tabs > commas ? '\t' : ','

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += c
    } else if (c === '"') {
      inQ = true
    } else if (c === delim) {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// Rendering every row of a 50k-line export would jank the preview; cap it and
// say so (never a silent truncation — the full file is one click away in Source).
const MAX_ROWS = 1000

/**
 * Read-only CSV/TSV table preview: the first row is a sticky header, data rows
 * are zebra-striped and numbered, columns are lightly tinted so they're easy to
 * track across, and the whole grid scrolls both ways inside its own box.
 */
export function CsvTable({ text }: { text: string }): JSX.Element {
  const { header, body, cols, total, truncated } = useMemo(() => {
    const all = parseDelimited(text)
    const [head = [], ...rest] = all
    const total = rest.length
    const truncated = rest.length > MAX_ROWS
    const body = truncated ? rest.slice(0, MAX_ROWS) : rest
    const cols = all.reduce((m, r) => Math.max(m, r.length), 0)
    return { header: head, body, cols, total, truncated }
  }, [text])

  if (header.length === 0) return <div className="csv-empty">Empty file.</div>

  const colIdx = Array.from({ length: cols }, (_, i) => i)

  return (
    <div className="csv-table-wrap">
      <table className="csv-table">
        <thead>
          <tr>
            <th className="csv-rownum" aria-hidden="true"></th>
            {colIdx.map((ci) => (
              <th key={ci} title={header[ci] ?? ''}>
                {header[ci] || <span className="csv-blank">col {ci + 1}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              <td className="csv-rownum">{ri + 1}</td>
              {colIdx.map((ci) => (
                <td key={ci} title={r[ci] ?? ''}>
                  {r[ci] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="csv-truncated">
          Showing the first {MAX_ROWS.toLocaleString()} of {total.toLocaleString()} rows — open{' '}
          <b>Source</b> for the full file.
        </div>
      )}
    </div>
  )
}
