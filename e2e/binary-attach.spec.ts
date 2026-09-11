import { test, expect } from '@playwright/test'
import { looksBinary } from '../src/main/services/fileService'
import { ATTACHABLE_EXTENSIONS } from '../src/shared/attachable'

/**
 * Angel: "we cannot attach doc/docx files and I presume there will be others?"
 *
 * Two faults. The picker's default filter listed pdf and rtf but not doc, docx,
 * xlsx or pptx, so they were greyed out. And whatever did get through was
 * decoded as UTF-8 — a .docx is a zip, so the agent received mojibake.
 */
test('office formats can be picked', () => {
  for (const ext of ['doc', 'docx', 'xlsx', 'pptx', 'odt', 'pages', 'key', 'epub']) {
    expect(ATTACHABLE_EXTENSIONS).toContain(ext)
  }
})

test('text formats are still picked', () => {
  for (const ext of ['md', 'txt', 'json', 'ts', 'csv']) {
    expect(ATTACHABLE_EXTENSIONS).toContain(ext)
  }
})

test('a zip-shaped document reads as binary', () => {
  // .docx/.xlsx/.pptx are zips: PK\x03\x04 then compressed bytes with NULs
  const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00])
  expect(looksBinary(docx)).toBe(true)
})

test('a PDF reads as binary', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0x01, 0x02])])
  expect(looksBinary(pdf)).toBe(true)
})

/** The point of checking CONTENT rather than a list of extensions: a format
 *  nobody thought to name is handled the same way. */
test('an unlisted binary format is caught anyway', () => {
  const sqlite = Buffer.concat([Buffer.from('SQLite format 3'), Buffer.from([0x00])])
  expect(looksBinary(sqlite)).toBe(true)
})

test('text with accents and emoji is not mistaken for binary', () => {
  expect(looksBinary(Buffer.from('# Título\n\nresumen — ✅ hecho\n', 'utf8'))).toBe(false)
})
