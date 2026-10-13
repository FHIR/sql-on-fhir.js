/**
 * Execution of SQLQuery and SQLView Libraries.
 *
 * Every `relatedArtifact[type=depends-on]` dependency is materialised into a
 * table in an in-memory SQLite database named after the artifact's `label`:
 * ViewDefinitions through the `evaluate()` engine, SQLViews by recursive
 * execution, ValueSets as a relation of their members and ConceptMaps as a
 * relation of their mappings. The Library's SQL then runs against those tables
 * with named parameter bindings.
 *
 * Author: John Grimes
 */

import sqlite3 from 'sqlite3'
import { fail, operationError, issue, SQL_TEXT_EXTENSION, viewColumns } from './common.js'
import { CONCEPT_MAP_COLUMNS, VALUE_SET_COLUMNS } from './terminology.js'

// Columns of the relation each kind of terminology dependency is exposed as.
const TERMINOLOGY_COLUMNS = { ValueSet: VALUE_SET_COLUMNS, ConceptMap: CONCEPT_MAP_COLUMNS }

// Map a FHIR Library.parameter.type to the `value[x]` field carrying it.
const PARAMETER_VALUE_FIELDS = {
  string: 'valueString',
  code: 'valueCode',
  integer: 'valueInteger',
  integer64: 'valueInteger64',
  decimal: 'valueDecimal',
  boolean: 'valueBoolean',
  date: 'valueDate',
  dateTime: 'valueDateTime',
  time: 'valueTime',
  instant: 'valueInstant',
}

// Map a ViewDefinition column type to a SQLite column affinity.
const SQLITE_AFFINITY = {
  boolean: 'INTEGER',
  integer: 'INTEGER',
  integer64: 'INTEGER',
  decimal: 'REAL',
}

// Map a FHIR column type to the `value[x]` field used by the `fhir` format.
const FHIR_TYPE_VALUE_FIELDS = {
  boolean: 'valueBoolean',
  integer: 'valueInteger',
  integer64: 'valueInteger64',
  decimal: 'valueDecimal',
  string: 'valueString',
  code: 'valueString',
  id: 'valueString',
  uri: 'valueString',
  url: 'valueString',
  canonical: 'valueString',
  date: 'valueDate',
  dateTime: 'valueDateTime',
  time: 'valueTime',
  instant: 'valueInstant',
  base64Binary: 'valueBase64Binary',
}

// Column definition for a materialised dependency table. A column whose FHIR
// type maps to an affinity gets it; any other column is declared without a
// type so that SQLite stores the engine's value as supplied (BLOB affinity)
// rather than converting numbers and booleans to text.
function columnDdl(name, type) {
  const affinity = SQLITE_AFFINITY[type]
  return affinity ? `"${name}" ${affinity}` : `"${name}"`
}

/**
 * The `value[x]` field for a declared FHIR column type.
 *
 * @param {string|undefined} type - FHIR type name, or undefined when the column declares none.
 * @returns {string|undefined} the field name, or undefined when the type is unknown.
 */
export function valueFieldForFhirType(type) {
  return type ? FHIR_TYPE_VALUE_FIELDS[type] : undefined
}

/**
 * Read the SQL text from a Library's first content entry, preferring the
 * `sql-text` extension and falling back to base64-decoded `data`.
 *
 * @param {object} library - SQLQuery or SQLView Library.
 * @returns {string} the SQL.
 * @throws {Error} 422 when no SQL can be located.
 */
export function extractSql(library) {
  const content = library?.content?.[0]
  const sqlText = (content?.extension || []).find((e) => e.url === SQL_TEXT_EXTENSION)
  if (typeof sqlText?.valueString === 'string') return sqlText.valueString
  if (typeof content?.data === 'string') return Buffer.from(content.data, 'base64').toString('utf8')
  fail(422, 'invalid', 'Library has no content entry carrying SQL', 'subject')
}

/**
 * Bind a nested Parameters resource to SQLite named parameters, checking each
 * name against `Library.parameter` and each value against the declared type.
 *
 * @param {object} library - The Library declaring the parameters.
 * @param {object|null} parametersResource - The supplied Parameters resource.
 * @param {string} [expression='parameters'] - Expression used in issues.
 * @returns {object} bindings keyed by `:name`.
 * @throws {Error} 400 for an undeclared name or a value of the wrong type.
 */
export function bindParameters(library, parametersResource, expression = 'parameters') {
  if (!parametersResource) return {}
  if (parametersResource.resourceType !== 'Parameters') {
    fail(400, 'invalid', "'parameters' must be a Parameters resource", expression)
  }
  const declared = library.parameter || []
  const bindings = {}
  for (const part of parametersResource.parameter || []) {
    const decl = declared.find((p) => p.name === part.name)
    if (!decl) fail(400, 'invalid', `Parameter '${part.name}' is not declared by the subject`, expression)
    const field = PARAMETER_VALUE_FIELDS[decl.type]
    if (!field)
      fail(
        400,
        'invalid',
        `Declared parameter type '${decl.type}' for '${part.name}' is not supported`,
        expression,
      )
    if (part[field] === undefined) {
      const supplied = Object.keys(part).find((k) => k.startsWith('value')) || '(none)'
      fail(
        400,
        'invalid',
        `Parameter '${part.name}' expects type '${decl.type}' but received '${supplied}'`,
        expression,
      )
    }
    let value = part[field]
    if (decl.type === 'boolean') value = value ? 1 : 0
    else if (decl.type === 'integer64') {
      value = Number(value)
      if (!Number.isFinite(value))
        fail(400, 'invalid', `Parameter '${part.name}' is not a valid integer64`, expression)
    }
    bindings[`:${part.name}`] = value
  }
  return bindings
}

function coerceForSqlite(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())))
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  )
}

function dbClose(db) {
  return new Promise((resolve) => db.close(() => resolve()))
}

async function insertRows(db, label, columns, rows) {
  if (rows.length === 0) return
  const colList = columns.map((c) => `"${c}"`).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  const insert = `INSERT INTO "${label}" (${colList}) VALUES (${placeholders})`
  await dbRun(db, 'BEGIN')
  try {
    for (const row of rows)
      await dbRun(
        db,
        insert,
        columns.map((c) => coerceForSqlite(row[c])),
      )
    await dbRun(db, 'COMMIT')
  } catch (err) {
    await dbRun(db, 'ROLLBACK').catch(() => {})
    throw err
  }
}

function libraryKey(library) {
  return library.url || (library.id ? `Library/${library.id}` : '__inline__')
}

/**
 * Column names of a SQL statement, recovered even when it yields no rows.
 * Named parameters cannot appear in a view definition, so they are replaced
 * with NULL for the probe; the column structure is unaffected. When the probe
 * itself fails the column list is simply unknown.
 */
async function probeColumns(db, sql) {
  try {
    await dbRun(db, `CREATE TEMP VIEW _col_probe AS ${sql.replace(/(?<![:\w]):\w+/g, 'NULL')}`)
    return (await dbAll(db, 'PRAGMA table_info(_col_probe)')).map((c) => c.name)
  } catch {
    return []
  } finally {
    await dbRun(db, 'DROP VIEW IF EXISTS _col_probe').catch(() => {})
  }
}

async function runSql(db, sql, bindings, expression) {
  let rows
  try {
    rows = await dbAll(db, sql, bindings)
  } catch (err) {
    throw operationError(422, [issue('invalid', `SQL execution failed: ${err.message}`, expression)])
  }
  const columns = rows.length > 0 ? Object.keys(rows[0]) : await probeColumns(db, sql)
  return { rows, columns }
}

// Prepare a statement without running it; SQLite reports syntax errors and
// unknown tables or columns at this stage.
function prepareSql(db, sql, expression) {
  return new Promise((resolve, reject) => {
    const statement = db.prepare(sql, (err) => (err ? reject(err) : resolve()))
    statement.finalize()
  }).catch((err) => {
    throw operationError(422, [issue('invalid', `SQL execution failed: ${err.message}`, expression)])
  })
}

/**
 * Materialise every dependency of a Library into tables on `db`.
 * Returns the declared FHIR column types of ViewDefinition, ValueSet and
 * ConceptMap dependencies, keyed by column name, for typing the `fhir` format.
 */
async function materialiseDependencies(library, db, ctx, stack) {
  const columnTypes = {}
  const declare = (columns) => {
    for (const c of columns) if (!(c.name in columnTypes)) columnTypes[c.name] = c.type
    return columns.map((c) => columnDdl(c.name, c.type)).join(', ')
  }
  for (const dep of (library.relatedArtifact || []).filter((a) => a.type === 'depends-on')) {
    const canonical = dep.resource || ''
    const artifact = ctx.resolveDependency(canonical)
    if (!artifact) {
      fail(
        404,
        'not-found',
        `Dependency '${dep.resource}' was neither supplied as a context entry nor resolvable by the server`,
      )
    }
    if (artifact.kind === 'ViewDefinition') {
      const view = artifact.resource
      const columns = viewColumns(view)
      if (columns.length === 0)
        fail(422, 'invalid', `ViewDefinition '${canonical}' declares no columns`, ctx.expression)
      await dbRun(db, `CREATE TABLE "${dep.label}" (${declare(columns)})`)
      await insertRows(
        db,
        dep.label,
        columns.map((c) => c.name),
        await ctx.evaluateView(view),
      )
    } else if (artifact.kind in TERMINOLOGY_COLUMNS) {
      const columns = TERMINOLOGY_COLUMNS[artifact.kind]
      await dbRun(db, `CREATE TABLE "${dep.label}" (${declare(columns)})`)
      await insertRows(
        db,
        dep.label,
        columns.map((c) => c.name),
        artifact.resource.rows,
      )
    } else {
      const { rows, columns, columnTypes: nested } = await runView(artifact.resource, ctx, stack)
      for (const [name, type] of Object.entries(nested)) if (!(name in columnTypes)) columnTypes[name] = type
      const ddl =
        columns.length > 0 ? columns.map((c) => columnDdl(c, nested[c])).join(', ') : '_empty INTEGER'
      await dbRun(db, `CREATE TABLE "${dep.label}" (${ddl})`)
      if (columns.length > 0) await insertRows(db, dep.label, columns, rows)
    }
  }
  return columnTypes
}

async function runView(library, ctx, stack) {
  const key = libraryKey(library)
  if (stack.has(key)) {
    fail(422, 'invalid', `Dependency cycle detected: ${[...stack, key].join(' -> ')}`, ctx.expression)
  }
  const childStack = new Set(stack).add(key)
  const db = new sqlite3.Database(':memory:')
  try {
    const columnTypes = await materialiseDependencies(library, db, ctx, childStack)
    const { rows, columns } = await runSql(db, extractSql(library), {}, ctx.expression)
    return { rows, columns, columnTypes }
  } finally {
    await dbClose(db)
  }
}

/**
 * Execute a SQLQuery or SQLView Library and return its rows.
 *
 * @param {object} options - Inputs.
 * @param {object} options.library - The Library to execute.
 * @param {object|null} options.parametersResource - Parameter values (ignored for a SQLView, which declares none).
 * @param {(canonical: string) => {kind: string, resource: object}|null} options.resolveDependency - Resolves a
 *   dependency canonical, as written in `relatedArtifact.resource`, to a ViewDefinition, SQLView, or the
 *   resolution of a ValueSet or ConceptMap (see `resolveTerminology`).
 * @param {(view: object) => Promise<object[]>} options.evaluateView - Produces the rows of a ViewDefinition dependency.
 * @param {string} [options.expression='subject'] - Expression used in issues raised by execution.
 * @param {boolean} [options.prepareOnly=false] - Prepare the statement instead of executing it, so that
 *   syntax errors and unknown tables or columns surface without paying the query's cost.
 * @returns {Promise<{rows: object[], columns: string[], valueFields: object}>} rows, column order and the `value[x]` field per column where a declared FHIR type is known.
 * @throws {Error} 400 for bad parameter bindings, 404 for an unresolvable dependency, 422 for a cycle or SQL error.
 */
export async function runLibrary({
  library,
  parametersResource,
  resolveDependency,
  evaluateView,
  expression = 'subject',
  prepareOnly = false,
}) {
  const ctx = { resolveDependency, evaluateView, expression }
  const db = new sqlite3.Database(':memory:')
  try {
    const stack = new Set([libraryKey(library)])
    const columnTypes = await materialiseDependencies(library, db, ctx, stack)
    const bindings = bindParameters(library, parametersResource)
    const sql = extractSql(library)
    if (prepareOnly) {
      await prepareSql(db, sql, expression)
      return { rows: [], columns: [], valueFields: {} }
    }
    const { rows, columns } = await runSql(db, sql, bindings, expression)
    // SQLite has no boolean type; columns declared boolean by a ViewDefinition
    // come back as 0/1 and are restored here so that every format sees
    // booleans. Only exact 0/1 cells are touched: a stored boolean can only
    // ever hold those, so a number under a boolean-named column is a computed
    // value (a count or sum) and is left alone.
    const booleans = columns.filter((c) => columnTypes[c] === 'boolean')
    for (const row of rows) {
      for (const c of booleans) {
        if (row[c] === 0) row[c] = false
        else if (row[c] === 1) row[c] = true
      }
    }
    const valueFields = {}
    for (const c of columns) valueFields[c] = valueFieldForFhirType(columnTypes[c])
    return { rows, columns, valueFields }
  } finally {
    await dbClose(db)
  }
}
