// MaterializedView — a prototype of the SQL on FHIR "materialize" resource.
//
// A MaterializedView is a server-managed, persisted relation built from a single
// ViewDefinition or SQLView (the `view`) on a `destination`. Identity is the pair
// (view, destination): at most one materialization per (view, destination), and
// `name` (the relation name within the destination) is unique per (destination,
// name). The whole lifecycle is plain FHIR REST (POST / GET / PUT / DELETE +
// search); building reuses the view runner in sql.js.
//
// Two destination backends are supported (the server advertises these; an
// unknown destination is rejected with 400):
//   - `sqlite` — the relation is a SQLite table.
//   - `csv`    — the relation is a CSV file under MV_CSV_DIR.
//
// This is a reference prototype: building is synchronous (the resource is
// returned with status = ready).

import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { materializeRefToRows } from './sql.js'

const MV_TABLE = 'materializedview'

// Supported destinations and their storage backend. A server advertises these
// (see the spec's CapabilityStatement-based discovery); an unknown destination
// is rejected with 400.
const DESTINATIONS = {
  sqlite: { kind: 'sqlite' },
  csv: { kind: 'csv' },
}
const DEFAULT_DESTINATION = 'sqlite'

// Read lazily (not at module-load) so MV_CSV_DIR set by callers/tests is honoured.
function csvDir() {
  return process.env.MV_CSV_DIR || './mv-csv'
}

// ---- SQLite promise helpers -------------------------------------------------

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  })
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  })
}

// ---- naming / typing --------------------------------------------------------

const FHIR_TO_SQLITE = {
  integer: 'INTEGER',
  positiveInt: 'INTEGER',
  unsignedInt: 'INTEGER',
  integer64: 'INTEGER',
  boolean: 'INTEGER',
  decimal: 'REAL',
}

function affinity(type) {
  return FHIR_TO_SQLITE[type] || 'TEXT'
}

// A valid SQL identifier: letters/digits/underscore, not starting with a digit.
function sanitizeIdent(s) {
  let out = String(s || '').replace(/[^A-Za-z0-9_]/g, '_')
  if (!/^[A-Za-z]/.test(out)) out = 'v_' + out
  return out
}

function deriveName(view) {
  const seg = String(view || '')
    .split('/')
    .pop()
  return sanitizeIdent(seg).toLowerCase()
}

function relationTable(destination, name) {
  return `mv_${sanitizeIdent(destination)}_${sanitizeIdent(name)}`
}

function csvFilePath(destination, name) {
  return path.join(csvDir(), `${sanitizeIdent(name)}.csv`)
}

function coerce(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

// ---- CSV --------------------------------------------------------------------

function csvCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function csvEscape(s) {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function writeCsv(filePath, columns, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const colNames = (columns && columns.length ? columns : []).map((c) => c.name)
  const lines = [colNames.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(colNames.map((c) => csvEscape(csvCell(row[c]))).join(','))
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n')
}

// Minimal RFC-4180-ish CSV parser → array of objects keyed by the header row.
function parseCsv(text) {
  const records = []
  let field = ''
  let record = []
  let inQuotes = false
  let i = 0
  const endField = () => {
    record.push(field)
    field = ''
  }
  const endRecord = () => {
    records.push(record)
    record = []
  }
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
      } else {
        field += ch
      }
      i++
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === ',') endField()
    else if (ch === '\n') {
      endField()
      endRecord()
    } else if (ch !== '\r') field += ch
    i++
  }
  if (field.length || record.length) {
    endField()
    endRecord()
  }
  if (!records.length) return []
  const header = records[0]
  return records.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? null])))
}

// ---- misc -------------------------------------------------------------------

function operationOutcome(code, message, severity = 'error') {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity, code, diagnostics: message }],
  }
}

function sendError(res, status, code, message) {
  res.status(status).json(operationOutcome(code, message))
}

// ---- storage ----------------------------------------------------------------

async function ensureMvTable(db) {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS ${MV_TABLE} (
       id TEXT PRIMARY KEY, view TEXT, destination TEXT, name TEXT, status TEXT, resource JSON)`,
  )
}

// Build the physical relation for a destination, dispatching on its backend.
async function buildRelation(db, destination, name, columns, rows) {
  const kind = DESTINATIONS[destination].kind
  if (kind === 'csv') {
    writeCsv(csvFilePath(destination, name), columns, rows)
    return
  }
  // sqlite
  const table = relationTable(destination, name)
  const cols = columns && columns.length ? columns : [{ name: '_empty', type: 'integer' }]
  const colNames = cols.map((c) => c.name)
  await run(db, `DROP TABLE IF EXISTS "${table}"`)
  await run(db, `CREATE TABLE "${table}" (${cols.map((c) => `"${c.name}" ${affinity(c.type)}`).join(', ')})`)
  if (!rows.length) return
  const placeholders = colNames.map(() => '?').join(', ')
  const insert = `INSERT INTO "${table}" (${colNames.map((n) => `"${n}"`).join(', ')}) VALUES (${placeholders})`
  for (const row of rows) {
    await run(
      db,
      insert,
      colNames.map((n) => coerce(row[n])),
    )
  }
}

// Read the materialised rows back, dispatching on the destination backend.
async function readRelation(db, destination, name) {
  if (DESTINATIONS[destination].kind === 'csv') {
    const file = csvFilePath(destination, name)
    if (!fs.existsSync(file)) return []
    return parseCsv(fs.readFileSync(file, 'utf8'))
  }
  return all(db, `SELECT * FROM "${relationTable(destination, name)}"`)
}

async function dropRelation(db, destination, name) {
  if (DESTINATIONS[destination].kind === 'csv') {
    const file = csvFilePath(destination, name)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return
  }
  await run(db, `DROP TABLE IF EXISTS "${relationTable(destination, name)}"`)
}

// ---- handlers ---------------------------------------------------------------

async function postMaterializedView(req, res) {
  const config = req.config
  const db = config.db
  const body = req.body || {}
  try {
    const view = body.view
    if (!view) return sendError(res, 400, 'required', 'MaterializedView.view is required')
    const destination = body.destination || DEFAULT_DESTINATION
    if (!DESTINATIONS[destination]) {
      return sendError(
        res,
        400,
        'not-supported',
        `Unsupported destination '${destination}'; this server supports: ${Object.keys(DESTINATIONS).join(', ')}.`,
      )
    }
    const name = sanitizeIdent(body.name || deriveName(view))

    await ensureMvTable(db)

    // Identity / uniqueness: one per (view, destination) and per (destination, name).
    const dupView = await get(db, `SELECT id FROM ${MV_TABLE} WHERE view = ? AND destination = ?`, [
      view,
      destination,
    ])
    if (dupView) {
      return sendError(
        res,
        409,
        'duplicate',
        `A materialization already exists for (view, destination) = (${view}, ${destination}); id ${dupView.id}.`,
      )
    }
    const dupName = await get(db, `SELECT id FROM ${MV_TABLE} WHERE destination = ? AND name = ?`, [
      destination,
      name,
    ])
    if (dupName) {
      return sendError(
        res,
        409,
        'duplicate',
        `A materialization already exists for (destination, name) = (${destination}, ${name}); id ${dupName.id}.`,
      )
    }

    // Build the relation by resolving and running the view.
    const built = await materializeRefToRows(config, view)
    await buildRelation(db, destination, name, built.columns, built.rows)

    const id = `mv-${randomUUID().slice(0, 8)}`
    const resource = {
      ...body,
      resourceType: 'MaterializedView',
      id,
      view,
      destination,
      name,
      type: body.type || {
        system: 'http://sql-on-fhir.org/materialize',
        code: DESTINATIONS[destination].kind,
      },
      status: 'ready',
      refreshedAt: new Date().toISOString(),
      rowCount: built.rows.length,
    }
    await run(
      db,
      `INSERT INTO ${MV_TABLE} (id, view, destination, name, status, resource) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, view, destination, name, 'ready', JSON.stringify(resource)],
    )
    res.setHeader('Location', `/MaterializedView/${id}`)
    res.status(201).json(resource)
  } catch (err) {
    sendError(res, err.status || 500, err.code || 'exception', err.message || String(err))
  }
}

async function readRecord(db, id) {
  const row = await get(db, `SELECT resource FROM ${MV_TABLE} WHERE id = ?`, [id])
  return row ? JSON.parse(row.resource) : null
}

async function getMaterializedView(req, res) {
  const db = req.config.db
  await ensureMvTable(db)
  const mv = await readRecord(db, req.params.id)
  if (!mv) return sendError(res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
  res.json(mv)
}

async function searchMaterializedView(req, res) {
  const db = req.config.db
  await ensureMvTable(db)
  const clauses = []
  const params = []
  for (const key of ['view', 'destination', 'name', 'status']) {
    if (req.query[key] != null) {
      clauses.push(`${key} = ?`)
      params.push(req.query[key])
    }
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = await all(db, `SELECT resource FROM ${MV_TABLE}${where}`, params)
  const entries = rows.map((r) => ({ resource: JSON.parse(r.resource) }))
  res.json({ resourceType: 'Bundle', type: 'searchset', total: entries.length, entry: entries })
}

// Convenience: read the materialised rows (the relation contents).
async function getMaterializedViewData(req, res) {
  const db = req.config.db
  await ensureMvTable(db)
  const mv = await readRecord(db, req.params.id)
  if (!mv) return sendError(res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
  res.json(await readRelation(db, mv.destination, mv.name))
}

async function putMaterializedView(req, res) {
  const config = req.config
  const db = config.db
  try {
    await ensureMvTable(db)
    const existing = await readRecord(db, req.params.id)
    if (!existing) return sendError(res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
    const built = await materializeRefToRows(config, existing.view)
    await buildRelation(db, existing.destination, existing.name, built.columns, built.rows)
    const resource = {
      ...existing,
      status: 'ready',
      refreshedAt: new Date().toISOString(),
      rowCount: built.rows.length,
    }
    await run(db, `UPDATE ${MV_TABLE} SET status = ?, resource = ? WHERE id = ?`, [
      'ready',
      JSON.stringify(resource),
      req.params.id,
    ])
    res.json(resource)
  } catch (err) {
    sendError(res, err.status || 500, err.code || 'exception', err.message || String(err))
  }
}

async function deleteMaterializedView(req, res) {
  const db = req.config.db
  await ensureMvTable(db)
  const mv = await readRecord(db, req.params.id)
  if (!mv) return sendError(res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
  await dropRelation(db, mv.destination, mv.name)
  await run(db, `DELETE FROM ${MV_TABLE} WHERE id = ?`, [req.params.id])
  res.json(operationOutcome('informational', `Dropped MaterializedView/${req.params.id}`, 'information'))
}

export function mountRoutes(app) {
  app.post('/MaterializedView', postMaterializedView)
  app.get('/MaterializedView', searchMaterializedView)
  app.get('/MaterializedView/:id/\\$data', getMaterializedViewData)
  app.get('/MaterializedView/:id', getMaterializedView)
  app.put('/MaterializedView/:id', putMaterializedView)
  app.delete('/MaterializedView/:id', deleteMaterializedView)
}
