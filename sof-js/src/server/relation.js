/**
 * External relations: a `StructureDefinition` logical model derived from the
 * SQL on FHIR `Relation` base describes a table that is not produced by a
 * ViewDefinition (a CSV of reference data, an OMOP vocabulary table, …). Its
 * `differential` elements are the columns; a repeatable `relation-source`
 * extension carries the data location as an Attachment `url`, one per format.
 * This module reads such a definition and produces the rows of the relation
 * so that `sqlEngine` can expose it under its dependency label.
 *
 * Data is always a file, never embedded in the definition: an `http(s):` url
 * is fetched, a `file:` url is read under the server's relation directory
 * (`config.relationDir`, default `metadata/relations/`). Runner configuration
 * wins over the definition: `config.relationSources[canonical]` names the
 * file or url to use regardless of what the definition says.
 *
 * `text/csv`, `application/x-ndjson` and `application/vnd.apache.parquet`
 * are loaded; a definition may offer several and the first supported one is
 * taken. Remote sources are fetched under `config.relationFetch`
 * (`allowHosts`, `maxBytes`, `timeoutMs`) so that an inline definition cannot
 * turn the server into an open proxy.
 *
 * Author: niquola
 */

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import { fail } from './common.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Default directory for `file:` relation sources: `metadata/relations/`. */
export const DEFAULT_RELATION_DIR = path.join(__dirname, '../../metadata/relations')

export const SPEC_BASE = 'http://hl7.org/fhir/uv/sql-on-fhir'
export const RELATION_BASE = `${SPEC_BASE}/StructureDefinition/Relation`
export const RELATION_SOURCE_EXTENSION = `${SPEC_BASE}/StructureDefinition/relation-source`
export const PRIMARY_KEY_EXTENSION = `${SPEC_BASE}/StructureDefinition/primary-key`
export const CSV = 'text/csv'
export const NDJSON = 'application/x-ndjson'
export const PARQUET = 'application/vnd.apache.parquet'
export const SUPPORTED_CONTENT_TYPES = [CSV, NDJSON, PARQUET]

/** FHIR primitive types a column may declare. */
export const PRIMITIVE_TYPES = [
  'boolean',
  'integer',
  'integer64',
  'positiveInt',
  'unsignedInt',
  'decimal',
  'string',
  'code',
  'id',
  'uri',
  'url',
  'canonical',
  'oid',
  'uuid',
  'date',
  'dateTime',
  'instant',
  'time',
  'base64Binary',
  'markdown',
]

/** Defaults for fetching `http(s):` sources. `allowHosts: null` means any host. */
export const DEFAULT_RELATION_FETCH = { allowHosts: null, maxBytes: 50 * 1024 * 1024, timeoutMs: 30000 }

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
 * with no dot) is skipped. A column without cardinality is `0..1`; `max`
 * other than `0` or `1` is a collection, which SQL has no column for and is
 * refused. A type is a FHIR primitive, or a canonical of another Relation,
 * which makes the column a foreign key (its SQL type is the referenced key's;
 * for storage it is left untyped). A `mapping` with identity `sql` names the
 * storage type; the `primary-key` extension marks key columns.
 *
 * @param {object} structureDefinition - A relation definition.
 * @returns {{name: string, type: string|undefined, min: number, max: string, reference: string|undefined, sqlType: string|undefined, primaryKey: boolean}[]}
 * @throws {Error} 422 when the definition declares no columns, nests elements, declares collections or non-primitive types.
 */
export function relationColumns(structureDefinition) {
  const canonical = structureDefinition.url || structureDefinition.id || 'inline'
  const elements = structureDefinition.differential?.element || []
  const columns = []
  const seen = new Set()
  for (const el of elements) {
    const path = String(el.path || '')
    const segments = path.split('.')
    if (segments.length < 2) continue
    if (segments.length > 2)
      fail(422, 'invalid', `Relation '${canonical}' nests element '${path}'; columns must be leaf elements`)
    const name = segments[1]
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      fail(422, 'invalid', `Relation '${canonical}' column '${name}' is not a valid SQL identifier`)
    if (seen.has(name)) fail(422, 'invalid', `Relation '${canonical}' declares column '${name}' twice`)
    seen.add(name)
    const max = String(el.max ?? '1')
    if (max !== '1' && max !== '0')
      fail(
        422,
        'not-supported',
        `Relation '${canonical}' column '${name}' has max ${max}; collections are not columns`,
      )
    const types = el.type || []
    if (types.length > 1)
      fail(
        422,
        'invalid',
        `Relation '${canonical}' column '${name}' declares ${types.length} types; a column has one`,
      )
    const code = types[0]?.code
    const reference = typeof code === 'string' && /^https?:/.test(code) ? code : undefined
    if (code !== undefined && !reference && !PRIMITIVE_TYPES.includes(code))
      fail(
        422,
        'not-supported',
        `Relation '${canonical}' column '${name}' has type '${code}'; only FHIR primitives or a Relation canonical are allowed`,
      )
    const sqlType = (el.mapping || []).find((m) => m.identity === 'sql')?.map
    const primaryKey = (el.extension || []).some(
      (e) => e.url === PRIMARY_KEY_EXTENSION && e.valueBoolean === true,
    )
    columns.push({
      name,
      type: reference ? undefined : code,
      reference,
      min: el.min ?? 0,
      max,
      sqlType: typeof sqlType === 'string' ? sqlType : undefined,
      primaryKey,
    })
  }
  if (columns.length === 0) fail(422, 'invalid', `Relation '${canonical}' declares no columns`)
  return columns
}

/**
 * Canonicals of the Relations a relation's foreign-key columns point at.
 *
 * @param {object[]} columns - From `relationColumns`.
 * @returns {string[]} distinct canonicals.
 */
export function referencedRelations(columns) {
  return [...new Set(columns.map((c) => c.reference).filter(Boolean))]
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

function bad(value, column, canonical, line) {
  fail(
    422,
    'invalid',
    `Relation '${canonical}' line ${line}: '${String(value)}' is not a ${column.type || 'value'} for column '${column.name}'`,
  )
}

/**
 * Coerce a cell to the column's FHIR type. Strings come from CSV; ndjson and
 * parquet supply native numbers, booleans and bigints. An empty string and
 * undefined are NULL.
 */
function convert(value, column, canonical, line) {
  if (value === null || value === undefined || value === '') return null
  switch (column.type) {
    case 'integer':
    case 'integer64':
    case 'positiveInt':
    case 'unsignedInt': {
      if (typeof value === 'bigint')
        return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
      if (typeof value === 'number')
        return Number.isInteger(value) ? value : bad(value, column, canonical, line)
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
      return bad(value, column, canonical, line)
    }
    case 'decimal': {
      const n = typeof value === 'bigint' ? Number(value) : Number(value)
      return Number.isFinite(n) && (typeof value !== 'string' || value.trim() !== '')
        ? n
        : bad(value, column, canonical, line)
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'number')
        return value === 1 ? true : value === 0 ? false : bad(value, column, canonical, line)
      const v = String(value).trim().toLowerCase()
      if (v === 'true' || v === '1') return true
      if (v === 'false' || v === '0') return false
      return bad(value, column, canonical, line)
    }
    default:
      if (typeof value === 'object') return JSON.stringify(value)
      return typeof value === 'bigint' ? value.toString() : String(value)
  }
}

/**
 * Validate and type a list of raw records (one object per row, keys = column
 * names) against the relation's columns.
 *
 * @param {object[]} records - Raw rows.
 * @param {string[]} fields - Field names present in the source.
 * @param {object[]} columns - From `relationColumns`.
 * @param {string} canonical - For diagnostics.
 * @param {number} [firstLine=2] - Line number of the first record, for diagnostics.
 * @returns {object[]} typed rows with every declared column.
 */
export function typedRows(records, fields, columns, canonical, firstLine = 2) {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const unknown = fields.filter((h) => !byName.has(h))
  if (unknown.length > 0)
    fail(
      422,
      'invalid',
      `Relation '${canonical}': source has columns not declared by the relation: ${unknown.join(', ')}`,
    )
  const missing = columns.filter((c) => c.min > 0 && !fields.includes(c.name)).map((c) => c.name)
  if (missing.length > 0)
    fail(422, 'invalid', `Relation '${canonical}': source lacks required columns: ${missing.join(', ')}`)
  return records.map((record, idx) => {
    const line = firstLine + idx
    const row = {}
    for (const c of columns) row[c.name] = convert(record[c.name], c, canonical, line)
    for (const c of columns)
      if (c.min > 0 && row[c.name] === null)
        fail(422, 'invalid', `Relation '${canonical}' line ${line}: required column '${c.name}' is empty`)
    return row
  })
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
  const records = parsed
    .slice(1)
    .filter((cells) => !(cells.length === 1 && cells[0] === ''))
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])))
  return typedRows(records, header, columns, canonical)
}

/**
 * Turn ndjson text (one JSON object per line) into typed rows.
 *
 * @param {string} text - ndjson text.
 * @param {object[]} columns - From `relationColumns`.
 * @param {string} canonical - For diagnostics.
 * @returns {object[]} rows.
 */
export function ndjsonRows(text, columns, canonical) {
  const records = []
  const fields = new Set()
  text.split(/\r?\n/).forEach((line, idx) => {
    if (line.trim() === '') return
    let record
    try {
      record = JSON.parse(line)
    } catch (err) {
      fail(422, 'invalid', `Relation '${canonical}' line ${idx + 1}: not valid JSON (${err.message})`)
    }
    if (!record || typeof record !== 'object' || Array.isArray(record))
      fail(422, 'invalid', `Relation '${canonical}' line ${idx + 1}: each line must be a JSON object`)
    Object.keys(record).forEach((k) => fields.add(k))
    records.push(record)
  })
  return typedRows(records, [...fields], columns, canonical, 1)
}

/**
 * Read a parquet file into typed rows.
 *
 * @param {Buffer|ArrayBuffer} bytes - Parquet file content.
 * @param {object[]} columns - From `relationColumns`.
 * @param {string} canonical - For diagnostics.
 * @returns {Promise<object[]>} rows.
 */
export async function parquetRows(bytes, columns, canonical) {
  const file =
    bytes instanceof ArrayBuffer
      ? bytes
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  let metadata
  try {
    metadata = await parquetMetadataAsync(file)
  } catch (err) {
    fail(422, 'invalid', `Relation '${canonical}': source is not a parquet file (${err.message})`)
  }
  const fields = metadata.schema
    .slice(1)
    .filter((s) => s.num_children === undefined || s.num_children === 0)
    .map((s) => s.name)
  const records = await parquetReadObjects({ file, metadata })
  return typedRows(records, fields, columns, canonical)
}

function contentTypeOf(attachment) {
  return String(attachment.contentType || '')
    .split(';')[0]
    .trim()
}

function guessContentType(location) {
  if (/\.csv$/i.test(location)) return 'text/csv'
  if (/\.parquet$/i.test(location)) return 'application/vnd.apache.parquet'
  if (/\.ndjson$/i.test(location)) return 'application/x-ndjson'
  return ''
}

/**
 * Resolve a `file:` url (or a bare relative path from configuration) to a
 * path under `relationDir`, refusing anything that escapes the directory.
 */
function localPath(location, relationDir, canonical) {
  const rel = location.startsWith('file:') ? decodeURIComponent(location.replace(/^file:\/*/, '')) : location
  const dir = path.resolve(relationDir)
  const full = path.resolve(dir, rel)
  if (full !== dir && !full.startsWith(dir + path.sep))
    fail(422, 'security', `Relation '${canonical}': source '${location}' is outside the relation directory`)
  return full
}

function hostAllowed(location, allowHosts) {
  if (!allowHosts) return true
  const host = new URL(location).hostname.toLowerCase()
  return allowHosts.some((h) => {
    const rule = String(h).toLowerCase()
    return rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule
  })
}

/**
 * Read a source as bytes. `http(s):` is fetched under `config.relationFetch`
 * (host allow-list, size cap, timeout); anything else is a file under
 * `config.relationDir`.
 */
async function readSource(location, config, canonical) {
  if (/^https?:/.test(location)) {
    const limits = { ...DEFAULT_RELATION_FETCH, ...(config.relationFetch || {}) }
    if (!hostAllowed(location, limits.allowHosts))
      fail(
        422,
        'security',
        `Relation '${canonical}': host of ${location} is not in the relation fetch allow-list`,
      )
    let res
    try {
      res = await fetch(location, { signal: AbortSignal.timeout(limits.timeoutMs), redirect: 'error' })
    } catch (err) {
      fail(422, 'exception', `Relation '${canonical}': source ${location} is unreachable (${err.message})`)
    }
    if (!res.ok) fail(422, 'not-found', `Relation '${canonical}': source ${location} answered ${res.status}`)
    const declared = Number(res.headers.get('content-length'))
    if (declared > limits.maxBytes)
      fail(
        422,
        'too-costly',
        `Relation '${canonical}': source ${location} is ${declared} bytes, over the ${limits.maxBytes} byte limit`,
      )
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > limits.maxBytes)
      fail(
        422,
        'too-costly',
        `Relation '${canonical}': source ${location} is ${bytes.length} bytes, over the ${limits.maxBytes} byte limit`,
      )
    return bytes
  }
  const full = localPath(location, config.relationDir || DEFAULT_RELATION_DIR, canonical)
  if (!fs.existsSync(full))
    fail(422, 'not-found', `Relation '${canonical}': source file ${full} does not exist`)
  return fs.readFileSync(full)
}

/**
 * Pick the data location of a relation: the runner's configuration
 * (`config.relationSources[canonical]`, keyed by url or url|version) first,
 * otherwise the first `relation-source` of the definition in a supported
 * format. Embedded `data` is not accepted: data lives in files.
 */
function chooseSource(structureDefinition, canonical, config) {
  const bound = config.relationSources?.[canonical] ?? config.relationSources?.[structureDefinition.url]
  if (bound) {
    const location = typeof bound === 'string' ? bound : bound.url
    const contentType = (typeof bound === 'object' && bound.contentType) || guessContentType(location)
    if (!SUPPORTED_CONTENT_TYPES.includes(contentType))
      fail(
        422,
        'not-supported',
        `Relation '${canonical}': configured source ${location} is '${contentType || '?'}', supported: ${SUPPORTED_CONTENT_TYPES.join(', ')}`,
      )
    return { location, contentType, origin: 'config' }
  }
  const sources = relationSources(structureDefinition)
  for (const a of sources) {
    if (a.data && !a.url)
      fail(
        422,
        'not-supported',
        `Relation '${canonical}': embedded relation-source data is not accepted; publish the file and reference it by url`,
      )
  }
  const source = sources.find(
    (a) => a.url && SUPPORTED_CONTENT_TYPES.includes(contentTypeOf(a) || guessContentType(a.url)),
  )
  if (!source) {
    const offered = sources.map((a) => a.contentType || a.url || '?').join(', ') || 'none'
    fail(
      422,
      'not-supported',
      `Relation '${canonical}' offers no source in a supported format (offered: ${offered}; supported: ${SUPPORTED_CONTENT_TYPES.join(', ')})`,
    )
  }
  return {
    location: source.url,
    contentType: contentTypeOf(source) || guessContentType(source.url),
    origin: 'definition',
  }
}

async function rowsOf(bytes, contentType, columns, canonical) {
  if (contentType === CSV) return csvRows(bytes.toString('utf8'), columns, canonical)
  if (contentType === NDJSON) return ndjsonRows(bytes.toString('utf8'), columns, canonical)
  if (contentType === PARQUET) return parquetRows(bytes, columns, canonical)
  fail(422, 'not-supported', `Relation '${canonical}': no reader for ${contentType}`)
}

/**
 * Load a relation: choose its data file (configuration first, then the
 * definition's `relation-source` entries), read and type the rows, and record
 * where the data came from and its sha256 so that a result can be traced to
 * the exact file.
 *
 * @param {object} structureDefinition - A relation definition.
 * @param {string} [canonical] - The canonical as written in the dependency, for diagnostics and configuration lookup.
 * @param {object} [config] - Server config: `relationDir`, `relationSources`, `relationFetch`.
 * @returns {Promise<{kind: 'Relation', resource: {canonical: string, resolvedUrl: string, resolvedVersion: string|null, columns: object[], rows: object[], source: string, origin: string, contentType: string, sha256: string, bytes: number, structureDefinition: object}}>}
 * @throws {Error} 422 when no source can be used or the data does not fit the columns.
 */
export async function loadRelation(structureDefinition, canonical = structureDefinition.url, config = {}) {
  const columns = relationColumns(structureDefinition)
  const { location, contentType, origin } = chooseSource(structureDefinition, canonical, config)
  const bytes = await readSource(location, config, canonical)
  const rows = await rowsOf(bytes, contentType, columns, canonical)
  return {
    kind: 'Relation',
    resource: {
      canonical,
      resolvedUrl: structureDefinition.url,
      resolvedVersion: structureDefinition.version ?? null,
      columns,
      rows,
      source: location,
      origin,
      contentType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
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
    `relation resolved: label=${label} canonical=${resource.canonical} resolved=${resource.resolvedUrl}|${resource.resolvedVersion ?? ''} source=${resource.source} (${resource.origin}) format=${resource.contentType} sha256=${resource.sha256} columns=${resource.columns.length} rows=${resource.rows.length}`,
  )
}
