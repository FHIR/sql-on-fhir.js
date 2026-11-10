/**
 * External relations: a `StructureDefinition` logical model derived from the
 * SQL on FHIR `Relation` base describes a table that is not produced by a
 * ViewDefinition (a CSV of reference data, an OMOP vocabulary table, …). Its
 * `differential` elements are the columns; a repeatable `relation-source`
 * extension carries the data as an Attachment (`data` or `url`), one per
 * format. This module reads such a definition and produces the rows of the
 * relation so that `sqlEngine` can expose it under its dependency label.
 *
 * Only `text/csv` is loaded for now; other formats are skipped so that a
 * definition can offer several and an engine takes the first it supports.
 *
 * Author: niquola
 */

import { fail } from './common.js'

export const SPEC_BASE = 'http://hl7.org/fhir/uv/sql-on-fhir'
export const RELATION_BASE = `${SPEC_BASE}/StructureDefinition/Relation`
export const RELATION_SOURCE_EXTENSION = `${SPEC_BASE}/StructureDefinition/relation-source`
export const SUPPORTED_CONTENT_TYPES = ['text/csv']

/**
 * Whether a resource is an external relation definition: a logical-model
 * StructureDefinition derived from the `Relation` base.
 *
 * @param {object} resource - Any resource.
 * @returns {boolean}
 */
export function isRelation(resource) {
  return (
    resource?.resourceType === 'StructureDefinition' &&
    resource.kind === 'logical' &&
    resource.baseDefinition === RELATION_BASE
  )
}

/**
 * Columns of a relation, in `differential` order. The root element (a path
 * with no dot) is skipped. A column without cardinality is `0..1`; a type
 * that is a canonical (starts with `http`) is a foreign key and is left
 * untyped for storage purposes.
 *
 * @param {object} structureDefinition - A relation definition.
 * @returns {{name: string, type: string|undefined, min: number, max: string, reference: string|undefined}[]}
 * @throws {Error} 422 when the definition declares no columns or nests elements.
 */
export function relationColumns(structureDefinition) {
  const canonical = structureDefinition.url || structureDefinition.id || 'inline'
  const elements = structureDefinition.differential?.element || []
  const columns = []
  for (const el of elements) {
    const path = String(el.path || '')
    const segments = path.split('.')
    if (segments.length < 2) continue
    if (segments.length > 2)
      fail(422, 'invalid', `Relation '${canonical}' nests element '${path}'; columns must be leaf elements`)
    const name = segments[1]
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      fail(422, 'invalid', `Relation '${canonical}' column '${name}' is not a valid SQL identifier`)
    const code = el.type?.[0]?.code
    const reference = typeof code === 'string' && /^https?:/.test(code) ? code : undefined
    columns.push({
      name,
      type: reference ? undefined : code,
      reference,
      min: el.min ?? 0,
      max: el.max ?? '1',
    })
  }
  if (columns.length === 0) fail(422, 'invalid', `Relation '${canonical}' declares no columns`)
  return columns
}

/**
 * The `relation-source` attachments of a definition, in declared order.
 *
 * @param {object} structureDefinition - A relation definition.
 * @returns {object[]} Attachment values.
 */
export function relationSources(structureDefinition) {
  return (structureDefinition.extension || [])
    .filter((e) => e.url === RELATION_SOURCE_EXTENSION && e.valueAttachment)
    .map((e) => e.valueAttachment)
}

/**
 * Parse RFC 4180 CSV text into rows of strings. Handles quoted fields with
 * embedded commas, quotes and newlines; CRLF and LF line ends; a trailing
 * newline.
 *
 * @param {string} text - CSV text.
 * @returns {string[][]} rows of cells.
 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  let i = 0
  if (text.charCodeAt(0) === 0xfeff) i = 1
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function convert(value, column, canonical, line) {
  if (value === '') return null
  switch (column.type) {
    case 'integer':
    case 'integer64':
    case 'positiveInt':
    case 'unsignedInt': {
      if (!/^-?\d+$/.test(value))
        fail(
          422,
          'invalid',
          `Relation '${canonical}' line ${line}: '${value}' is not an ${column.type} for column '${column.name}'`,
        )
      return Number(value)
    }
    case 'decimal': {
      const n = Number(value)
      if (!Number.isFinite(n))
        fail(
          422,
          'invalid',
          `Relation '${canonical}' line ${line}: '${value}' is not a decimal for column '${column.name}'`,
        )
      return n
    }
    case 'boolean': {
      const v = value.toLowerCase()
      if (v === 'true' || v === '1') return true
      if (v === 'false' || v === '0') return false
      fail(
        422,
        'invalid',
        `Relation '${canonical}' line ${line}: '${value}' is not a boolean for column '${column.name}'`,
      )
    }
    // falls through
    default:
      return value
  }
}

/**
 * Turn CSV text into typed rows keyed by column name. The header names the
 * columns; every column with `min: 1` must be present and non-empty.
 *
 * @param {string} text - CSV text with a header line.
 * @param {object[]} columns - From `relationColumns`.
 * @param {string} canonical - For diagnostics.
 * @returns {object[]} rows.
 */
export function csvRows(text, columns, canonical) {
  const parsed = parseCsv(text)
  if (parsed.length === 0) fail(422, 'invalid', `Relation '${canonical}': CSV source is empty`)
  const header = parsed[0].map((h) => h.trim())
  const byName = new Map(columns.map((c) => [c.name, c]))
  const unknown = header.filter((h) => !byName.has(h))
  if (unknown.length > 0)
    fail(
      422,
      'invalid',
      `Relation '${canonical}': CSV header has columns not declared by the relation: ${unknown.join(', ')}`,
    )
  const missing = columns.filter((c) => c.min > 0 && !header.includes(c.name)).map((c) => c.name)
  if (missing.length > 0)
    fail(422, 'invalid', `Relation '${canonical}': CSV header lacks required columns: ${missing.join(', ')}`)
  const rows = []
  for (let r = 1; r < parsed.length; r++) {
    const cells = parsed[r]
    if (cells.length === 1 && cells[0] === '') continue
    const row = {}
    for (const c of columns) row[c.name] = null
    header.forEach((h, idx) => {
      row[h] = convert(cells[idx] ?? '', byName.get(h), canonical, r + 1)
    })
    for (const c of columns)
      if (c.min > 0 && row[c.name] === null)
        fail(422, 'invalid', `Relation '${canonical}' line ${r + 1}: required column '${c.name}' is empty`)
    rows.push(row)
  }
  return rows
}

async function attachmentText(attachment, canonical) {
  if (attachment.data) return Buffer.from(attachment.data, 'base64').toString('utf8')
  if (attachment.url) {
    let res
    try {
      res = await fetch(attachment.url)
    } catch (err) {
      fail(
        422,
        'exception',
        `Relation '${canonical}': source ${attachment.url} is unreachable (${err.message})`,
      )
    }
    if (!res.ok)
      fail(422, 'not-found', `Relation '${canonical}': source ${attachment.url} answered ${res.status}`)
    return res.text()
  }
  fail(422, 'invalid', `Relation '${canonical}': a relation-source has neither data nor url`)
}

/**
 * Load a relation: pick the first `relation-source` in a supported format and
 * read its rows.
 *
 * @param {object} structureDefinition - A relation definition.
 * @param {string} [canonical] - The canonical as written in the dependency, for diagnostics.
 * @returns {Promise<{kind: 'Relation', resource: {canonical: string, columns: object[], rows: object[], source: string, contentType: string, structureDefinition: object}}>}
 * @throws {Error} 422 when no source can be used or the data does not fit the columns.
 */
export async function loadRelation(structureDefinition, canonical = structureDefinition.url) {
  const columns = relationColumns(structureDefinition)
  const sources = relationSources(structureDefinition)
  const source = sources.find((a) =>
    SUPPORTED_CONTENT_TYPES.includes(
      String(a.contentType || '')
        .split(';')[0]
        .trim(),
    ),
  )
  if (!source) {
    const offered = sources.map((a) => a.contentType || '?').join(', ') || 'none'
    fail(
      422,
      'not-supported',
      `Relation '${canonical}' offers no source in a supported format (offered: ${offered}; supported: ${SUPPORTED_CONTENT_TYPES.join(', ')})`,
    )
  }
  const text = await attachmentText(source, canonical)
  const rows = csvRows(text, columns, canonical)
  return {
    kind: 'Relation',
    resource: {
      canonical,
      columns,
      rows,
      source: source.data ? 'embedded' : source.url,
      contentType: source.contentType,
      structureDefinition,
    },
  }
}

/**
 * One-line provenance record for a loaded relation.
 *
 * @param {string} label - SQL identifier the relation is bound to.
 * @param {{resource: object}} loaded - Result of `loadRelation`.
 */
export function logRelationResolution(label, { resource }) {
  console.log(
    `relation resolved: label=${label} canonical=${resource.canonical} source=${resource.source} format=${resource.contentType} columns=${resource.columns.length} rows=${resource.rows.length}`,
  )
}
