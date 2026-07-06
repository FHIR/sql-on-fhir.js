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
// Endpoints content-negotiate: HTML (a small htmx/Tailwind UI) when the client
// accepts text/html, otherwise JSON. Building is synchronous (status = ready).

import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { materializeRefToRows } from './sql.js'
import { search, run, get, all } from './db.js'
import { layout, escapeHtml } from './ui.js'
import { isHtml, sanitizeIdent, csvField } from './utils.js'

const MV_TABLE = 'materializedview'

const DESTINATIONS = {
  sqlite: { kind: 'sqlite' },
  csv: { kind: 'csv' },
}
const DEFAULT_DESTINATION = 'sqlite'

// The destinations this server can serve materializations from (for callers
// like $sqlquery-run that let a user pick where to run against).
export function availableDestinations() {
  return Object.keys(DESTINATIONS)
}

// Read lazily (not at module-load) so MV_CSV_DIR set by callers/tests is honoured.
function csvDir() {
  return process.env.MV_CSV_DIR || './mv-csv'
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

function deriveName(view) {
  const seg = String(view || '')
    .split('/')
    .pop()
  return sanitizeIdent(seg).toLowerCase()
}

function relationTable(destination, name) {
  return `mv_${sanitizeIdent(destination)}_${sanitizeIdent(name)}`
}

// Quote a SQL identifier for a double-quoted context, escaping embedded quotes.
// Column names come straight from the ViewDefinition (which this server does not
// constrain), so a name containing `"` must not break out of the identifier.
function quoteIdent(id) {
  return `"${String(id).replace(/"/g, '""')}"`
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

function writeCsv(filePath, columns, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const colNames = (columns && columns.length ? columns : []).map((c) => c.name)
  const lines = [colNames.map(csvField).join(',')]
  for (const row of rows) {
    lines.push(colNames.map((c) => csvField(row[c])).join(','))
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n')
}

// Parse CSV text into an array of records (each a string[] of fields).
function parseCsvRecords(text) {
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
  return records
}

function parseCsv(text) {
  const records = parseCsvRecords(text)
  if (!records.length) return []
  const header = records[0]
  return records.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? null])))
}

// The header row (column names) of a CSV file, independent of row count.
function parseCsvHeader(text) {
  const records = parseCsvRecords(text)
  return records.length ? records[0] : []
}

// ---- misc -------------------------------------------------------------------

function operationOutcome(code, message, severity = 'error') {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity, code, diagnostics: message }],
  }
}

// Content-negotiating error: an HTML page when the client accepts text/html,
// otherwise an OperationOutcome.
function sendError(req, res, status, code, message) {
  if (isHtml(req)) {
    res.status(status).setHeader('Content-Type', 'text/html')
    return res.send(
      layout(`<div class="container mx-auto p-4">
        <a href="/MaterializedView" class="text-blue-500 hover:text-blue-700">← Materialized Views</a>
        <div class="mt-4 p-4 border border-red-300 bg-red-50 rounded">
          <div class="font-bold">${status} · ${code}</div>
          <div class="mt-1">${escapeHtml(message)}</div>
        </div>
      </div>`),
    )
  }
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

async function buildRelation(db, destination, name, columns, rows) {
  const kind = DESTINATIONS[destination].kind
  if (kind === 'csv') {
    writeCsv(csvFilePath(destination, name), columns, rows)
    return
  }
  const table = relationTable(destination, name)
  const cols = columns && columns.length ? columns : [{ name: '_empty', type: 'integer' }]
  const colNames = cols.map((c) => c.name)
  await run(db, `DROP TABLE IF EXISTS "${table}"`)
  await run(
    db,
    `CREATE TABLE "${table}" (${cols.map((c) => `${quoteIdent(c.name)} ${affinity(c.type)}`).join(', ')})`,
  )
  if (!rows.length) return
  const placeholders = colNames.map(() => '?').join(', ')
  const insert = `INSERT INTO "${table}" (${colNames.map(quoteIdent).join(', ')}) VALUES (${placeholders})`
  // One transaction + one prepared statement: N implicit commits (an fsync each)
  // and N SQL parses collapse to one, so building a large relation is ~O(1) commits.
  await run(db, 'BEGIN')
  try {
    const stmt = db.prepare(insert)
    try {
      for (const row of rows) {
        await new Promise((resolve, reject) =>
          stmt.run(
            colNames.map((n) => coerce(row[n])),
            (err) => (err ? reject(err) : resolve()),
          ),
        )
      }
    } finally {
      await new Promise((resolve, reject) => stmt.finalize((err) => (err ? reject(err) : resolve())))
    }
    await run(db, 'COMMIT')
  } catch (err) {
    await run(db, 'ROLLBACK').catch(() => {})
    throw err
  }
}

async function readRelation(db, destination, name) {
  if (DESTINATIONS[destination].kind === 'csv') {
    const file = csvFilePath(destination, name)
    if (!fs.existsSync(file)) return []
    return parseCsv(fs.readFileSync(file, 'utf8'))
  }
  return all(db, `SELECT * FROM "${relationTable(destination, name)}"`)
}

// The relation's column names from its schema — available even when the
// relation has zero rows (so callers don't have to derive columns from data).
async function readRelationColumns(db, destination, name) {
  if (DESTINATIONS[destination].kind === 'csv') {
    const file = csvFilePath(destination, name)
    if (!fs.existsSync(file)) return []
    return parseCsvHeader(fs.readFileSync(file, 'utf8'))
  }
  const info = await all(db, `PRAGMA table_info("${relationTable(destination, name)}")`)
  return info.map((c) => c.name)
}

async function dropRelation(db, destination, name) {
  if (DESTINATIONS[destination].kind === 'csv') {
    const file = csvFilePath(destination, name)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return
  }
  await run(db, `DROP TABLE IF EXISTS "${relationTable(destination, name)}"`)
}

// ---- run-by-destination -----------------------------------------------------

// Serve a `$run` from a materialization instead of recomputing the view. Given
// the ViewDefinition/SQLView being run and a `destination`, find its
// materialization on that destination and return the stored relation rows.
//   - unsupported destination → throws (status 400)
//   - no materialization for this view on the destination → returns null (caller 404s)
// The view is matched only by its canonical `url` or its typed
// `<resourceType>/<id>` reference — never by a bare id, which is ambiguous
// across resource types (a ViewDefinition and a Library sharing an id could
// otherwise mis-serve each other). Candidates are tried in priority order.
export async function runFromDestination(config, view, destination) {
  const db = config.db
  if (!DESTINATIONS[destination]) {
    const err = new Error(
      `Unsupported destination '${destination}'; this server supports: ${Object.keys(DESTINATIONS).join(', ')}.`,
    )
    err.status = 400
    err.code = 'not-supported'
    throw err
  }
  await ensureMvTable(db)
  const candidates = [view.url, view.id && `${view.resourceType}/${view.id}`].filter(Boolean)
  if (!candidates.length) return null
  const placeholders = candidates.map(() => '?').join(', ')
  const rows = await all(
    db,
    `SELECT view, resource FROM ${MV_TABLE} WHERE view IN (${placeholders}) AND destination = ?`,
    [...candidates, destination],
  )
  if (!rows.length) return null
  // Honour candidate priority (url before typed ref) when both are registered.
  const byRef = new Map(rows.map((r) => [r.view, r]))
  const chosen = candidates.map((c) => byRef.get(c)).find(Boolean)
  const record = JSON.parse(chosen.resource)
  const relationRows = await readRelation(db, record.destination, record.name)
  const columns = await readRelationColumns(db, record.destination, record.name)
  return { materializedView: record, rows: relationRows, columns }
}

// ---- HTML UI ----------------------------------------------------------------

const breadcrumb = (...parts) =>
  `<div class="flex gap-2 items-center text-sm">${[
    '<a href="/" class="text-blue-500 hover:text-blue-700">Home</a>',
    ...parts,
  ].join('<span class="text-gray-400">/</span>')}</div>`

const STATUS_STYLES = {
  ready: 'bg-green-100 text-green-800',
  building: 'bg-blue-100 text-blue-800',
  requested: 'bg-gray-100 text-gray-700',
  stale: 'bg-amber-100 text-amber-800',
  failed: 'bg-red-100 text-red-800',
}

function statusPill(status) {
  const cls = STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'
  return `<span class="px-2 py-0.5 rounded-full text-xs font-medium ${cls}">${escapeHtml(status || 'unknown')}</span>`
}

const RELATION_ICON = `<svg class="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm6.5.75v3h3v-3Zm3 4.5h-3v3h3Zm1.5 3h3v-3h-3Zm3-4.5v-3h-3v3Zm-9-3h-3v3h3Zm-3 4.5v3h3v-3Z"/>
</svg>`

function mvRow(mv) {
  return `
      <li class="group flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
        ${RELATION_ICON}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <a href="/MaterializedView/${mv.id}/$data"
               class="font-mono font-semibold text-blue-600 hover:underline truncate">${escapeHtml(mv.name)}</a>
            ${statusPill(mv.status)}
          </div>
          <div class="mt-0.5 text-xs text-gray-500 truncate" title="${escapeHtml(mv.view)}">${escapeHtml(mv.view)}</div>
        </div>
        <div class="shrink-0 text-right tabular-nums text-sm text-gray-500 w-20">${
          mv.rowCount != null ? `${mv.rowCount} <span class="text-gray-400">rows</span>` : ''
        }</div>
        <div class="shrink-0 flex items-center gap-3 text-sm">
          <span class="font-mono text-gray-400 text-xs hidden sm:inline">${mv.id}</span>
          <a class="text-blue-600 hover:underline" href="/MaterializedView/${mv.id}/$data">data</a>
          <button class="text-red-500 hover:text-red-700 opacity-60 group-hover:opacity-100"
            hx-delete="/MaterializedView/${mv.id}" hx-confirm="Drop ${mv.name}?"
            hx-on::after-request="window.location.reload()">delete</button>
        </div>
      </li>`
}

function mvGroup(destination, items) {
  return `
    <section class="mt-6">
      <div class="flex items-center gap-2 mb-2">
        <span class="px-2 py-0.5 rounded bg-slate-100 font-mono text-sm font-semibold">${escapeHtml(destination)}</span>
        <span class="text-gray-400 text-sm">${items.length} relation${items.length === 1 ? '' : 's'}</span>
      </div>
      <ul class="border border-gray-200 rounded-md divide-y divide-gray-200 overflow-hidden">
        ${items.map(mvRow).join('')}
      </ul>
    </section>`
}

function htmlList(resources) {
  const groups = new Map()
  for (const mv of resources) {
    const key = mv.destination || '(default)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(mv)
  }
  const body = resources.length
    ? [...groups.keys()]
        .sort()
        .map((dest) => mvGroup(dest, groups.get(dest)))
        .join('')
    : `<div class="mt-6 border border-dashed border-gray-300 rounded-md p-8 text-center text-gray-500">
         No materializations yet. <a href="/MaterializedView/new" class="text-blue-600 hover:underline">Create one</a>.
       </div>`
  return layout(`
    <div class="container mx-auto p-4 max-w-4xl">
      ${breadcrumb('<span>Materialized Views</span>')}
      <div class="mt-4 flex items-center border-b border-gray-200 pb-2">
        <h1 class="flex-1 text-2xl font-bold">Materialized Views</h1>
        <a href="/MaterializedView/new" class="btn">New</a>
      </div>
      ${body}
    </div>`)
}

const DESTINATION_LABELS = {
  sqlite: 'sqlite — a SQLite table',
  csv: 'csv — a CSV file',
}

const field = (label, hint, control) => `
  <div>
    <label class="block font-semibold mb-1">${label}${
      hint ? ` <span class="text-gray-400 font-normal text-sm">${hint}</span>` : ''
    }</label>
    ${control}
  </div>`

const INPUT = 'border border-gray-300 rounded p-2 w-full'

function htmlNewForm(views) {
  const opts = views
    .map((v) => `<option value="${escapeHtml(v.value)}">${escapeHtml(v.label)}</option>`)
    .join('')
  const destOpts = Object.keys(DESTINATIONS)
    .map((d) => `<option value="${d}">${escapeHtml(DESTINATION_LABELS[d] || d)}</option>`)
    .join('')
  const unitOpts = [
    ['', 'on-demand only (no target)'],
    ['s', 'seconds'],
    ['min', 'minutes'],
    ['h', 'hours'],
    ['d', 'days'],
  ]
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join('')
  return layout(`
    <div class="container mx-auto p-4 max-w-2xl">
      ${breadcrumb('<a href="/MaterializedView" class="text-blue-500">Materialized Views</a>', '<span>New</span>')}
      <h1 class="mt-4 text-2xl font-bold">New Materialized View</h1>
      <form method="post" action="/MaterializedView" class="mt-4 space-y-5">

        <fieldset class="space-y-4">
          <legend class="text-sm font-semibold text-gray-500 uppercase tracking-wide">Identity</legend>
          ${field('View', '(required) — the ViewDefinition / SQLView to materialize', `<select name="view" class="${INPUT}">${opts}</select>`)}
          ${field('Destination', 'where the relation lives — one materialization per (view, destination)', `<select name="destination" class="${INPUT}">${destOpts}</select>`)}
          ${field('Name', '(optional) relation name; unique per destination; derived from the view if blank', `<input name="name" class="${INPUT}" placeholder="e.g. patients" />`)}
          ${field('Identifier', '(optional) business identifier', `<div class="flex gap-2"><input name="identifier_system" class="${INPUT}" placeholder="system (uri)" /><input name="identifier_value" class="${INPUT}" placeholder="value" /></div>`)}
        </fieldset>

        <fieldset class="space-y-4">
          <legend class="text-sm font-semibold text-gray-500 uppercase tracking-wide">Type &amp; freshness</legend>
          ${field('Type', '(optional) materialization kind/format — vendor-extensible; defaults to the destination kind', `<div class="flex gap-2"><input name="type_system" class="${INPUT}" placeholder="system (e.g. postgres)" /><input name="type_code" class="${INPUT}" placeholder="code (e.g. unlogged-table, parquet)" /></div>`)}
          ${field('Staleness', 'freshness target — how far the relation may lag; blank = on-demand, 0 = live', `<div class="flex gap-2"><input name="staleness_value" type="number" min="0" step="1" class="${INPUT}" placeholder="value" /><select name="staleness_unit" class="${INPUT}">${unitOpts}</select></div>`)}
        </fieldset>

        <fieldset class="space-y-4">
          <legend class="text-sm font-semibold text-gray-500 uppercase tracking-wide">Dependencies</legend>
          ${field('Depends on', '(optional) physical upstream materializations — one reference per line (MaterializedView/&lt;id&gt;)', `<textarea name="dependsOn" rows="3" class="${INPUT} font-mono text-sm" placeholder="MaterializedView/mv-abc123&#10;MaterializedView/mv-def456"></textarea>`)}
        </fieldset>

        <p class="text-xs text-gray-400">
          <span class="font-semibold">status</span>, <span class="font-semibold">refreshedAt</span>,
          <span class="font-semibold">rowCount</span> and <span class="font-semibold">error</span> are
          server-managed and set on build.
        </p>

        <button type="submit" class="btn">Materialize</button>
      </form>
    </div>`)
}

function htmlData(mv, rows) {
  const cols = rows.length ? Object.keys(rows[0]) : []
  const head = cols.map((c) => `<th class="bg-gray-100 border p-2 text-left">${escapeHtml(c)}</th>`).join('')
  const body =
    rows
      .map(
        (r) =>
          `<tr>${cols.map((c) => `<td class="border p-2 text-sm">${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`,
      )
      .join('') || `<tr><td colspan="${cols.length || 1}" class="p-4 text-gray-500">No rows.</td></tr>`
  return layout(`
    <div class="container mx-auto p-4">
      ${breadcrumb('<a href="/MaterializedView" class="text-blue-500">Materialized Views</a>', `<span>${mv.name}</span>`)}
      <h1 class="mt-4 text-2xl font-bold">
        ${mv.destination}.${mv.name}
        <span class="text-sm font-normal text-gray-500">— ${mv.rowCount} rows · ${mv.status} · ${escapeHtml(mv.view)}</span>
      </h1>
      <table class="mt-4 table-auto border-collapse border border-gray-200 w-full">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`)
}

async function listViews(config) {
  const vds = await search(config, 'ViewDefinition', 1000)
  const libs = (await search(config, 'Library', 1000)).filter((l) =>
    (l.type?.coding || []).some((c) => c.code === 'sql-view'),
  )
  return [
    ...vds.map((v) => ({
      value: v.url || `ViewDefinition/${v.id}`,
      label: `ViewDefinition · ${v.name || v.id}`,
    })),
    ...libs.map((l) => ({ value: l.url || `Library/${l.id}`, label: `SQLView · ${l.name || l.id}` })),
  ]
}

// Normalize the optional input parameters: accept either nested JSON (API) or
// flat form fields (HTML form) and return the canonical resource shape. Empty
// values collapse to undefined so defaults apply and nothing leaks into storage.
function normalizeInput(body) {
  const out = {}

  // type — Coding {system, code}; nested wins, else flat type_system/type_code
  const type =
    body.type ||
    (body.type_system || body.type_code
      ? { system: body.type_system || undefined, code: body.type_code || undefined }
      : undefined)
  if (type && (type.system || type.code)) out.type = type

  // staleness — Duration; nested wins, else flat staleness_value/staleness_unit
  if (body.staleness) {
    out.staleness = body.staleness
  } else if (body.staleness_value !== undefined && body.staleness_value !== '') {
    const unit = body.staleness_unit || 's'
    out.staleness = {
      value: Number(body.staleness_value),
      unit,
      code: unit,
      system: 'http://unitsofmeasure.org',
    }
  }

  // identifier — token {system, value}
  const identifier =
    body.identifier ||
    (body.identifier_system || body.identifier_value
      ? { system: body.identifier_system || undefined, value: body.identifier_value || undefined }
      : undefined)
  if (identifier && (identifier.system || identifier.value)) out.identifier = identifier

  // dependsOn — Reference(MaterializedView)[]; array (JSON) or newline/comma text (form)
  if (Array.isArray(body.dependsOn)) {
    if (body.dependsOn.length) out.dependsOn = body.dependsOn
  } else if (typeof body.dependsOn === 'string') {
    const refs = body.dependsOn
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((reference) => ({ reference }))
    if (refs.length) out.dependsOn = refs
  }

  return out
}

// ---- handlers ---------------------------------------------------------------

async function postMaterializedView(req, res) {
  const config = req.config
  const db = config.db
  const body = req.body || {}
  try {
    const view = body.view
    if (!view) return sendError(req, res, 400, 'required', 'MaterializedView.view is required')
    const destination = body.destination || DEFAULT_DESTINATION
    if (!DESTINATIONS[destination]) {
      return sendError(
        req,
        res,
        400,
        'not-supported',
        `Unsupported destination '${destination}'; this server supports: ${Object.keys(DESTINATIONS).join(', ')}.`,
      )
    }
    const name = sanitizeIdent(body.name || deriveName(view))

    await ensureMvTable(db)

    const dupView = await get(db, `SELECT id FROM ${MV_TABLE} WHERE view = ? AND destination = ?`, [
      view,
      destination,
    ])
    if (dupView) {
      return sendError(
        req,
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
        req,
        res,
        409,
        'duplicate',
        `A materialization already exists for (destination, name) = (${destination}, ${name}); id ${dupName.id}.`,
      )
    }

    const built = await materializeRefToRows(config, view)
    await buildRelation(db, destination, name, built.columns, built.rows)

    const id = `mv-${randomUUID().slice(0, 8)}`
    const input = normalizeInput(body)
    const resource = {
      resourceType: 'MaterializedView',
      id,
      ...(input.identifier ? { identifier: input.identifier } : {}),
      view,
      destination,
      name,
      type: input.type || {
        system: 'http://sql-on-fhir.org/materialize',
        code: DESTINATIONS[destination].kind,
      },
      ...(input.staleness ? { staleness: input.staleness } : {}),
      ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
      status: 'ready',
      refreshedAt: new Date().toISOString(),
      rowCount: built.rows.length,
    }
    await run(
      db,
      `INSERT INTO ${MV_TABLE} (id, view, destination, name, status, resource) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, view, destination, name, 'ready', JSON.stringify(resource)],
    )
    if (isHtml(req)) return res.redirect(303, '/MaterializedView')
    res.setHeader('Location', `/MaterializedView/${id}`)
    res.status(201).json(resource)
  } catch (err) {
    sendError(req, res, err.status || 500, err.code || 'exception', err.message || String(err))
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
  if (!mv) return sendError(req, res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
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
  const resources = rows.map((r) => JSON.parse(r.resource))
  if (isHtml(req)) {
    res.setHeader('Content-Type', 'text/html')
    return res.send(htmlList(resources))
  }
  res.json({
    resourceType: 'Bundle',
    type: 'searchset',
    total: resources.length,
    entry: resources.map((resource) => ({ resource })),
  })
}

async function getNewForm(req, res) {
  const views = await listViews(req.config)
  res.setHeader('Content-Type', 'text/html')
  res.send(htmlNewForm(views))
}

async function getMaterializedViewData(req, res) {
  const db = req.config.db
  await ensureMvTable(db)
  const mv = await readRecord(db, req.params.id)
  if (!mv) return sendError(req, res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
  const rows = await readRelation(db, mv.destination, mv.name)
  if (isHtml(req)) {
    res.setHeader('Content-Type', 'text/html')
    return res.send(htmlData(mv, rows))
  }
  res.json(rows)
}

async function putMaterializedView(req, res) {
  const config = req.config
  const db = config.db
  try {
    await ensureMvTable(db)
    const existing = await readRecord(db, req.params.id)
    if (!existing) return sendError(req, res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
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
    sendError(req, res, err.status || 500, err.code || 'exception', err.message || String(err))
  }
}

async function deleteMaterializedView(req, res) {
  const db = req.config.db
  await ensureMvTable(db)
  const mv = await readRecord(db, req.params.id)
  if (!mv) return sendError(req, res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
  await dropRelation(db, mv.destination, mv.name)
  await run(db, `DELETE FROM ${MV_TABLE} WHERE id = ?`, [req.params.id])
  if (req.headers['hx-request']) return res.status(200).send('')
  res.json(operationOutcome('informational', `Dropped MaterializedView/${req.params.id}`, 'information'))
}

// Express 4 does not forward rejections from async handlers, so an awaited
// failure (e.g. a relation table that was dropped out-of-band) would hang the
// request. Wrap every handler so errors always produce a negotiated response.
function guard(handler) {
  return (req, res) =>
    Promise.resolve(handler(req, res)).catch((err) =>
      sendError(req, res, err?.status || 500, err?.code || 'exception', err?.message || String(err)),
    )
}

export function mountRoutes(app) {
  app.post('/MaterializedView', guard(postMaterializedView))
  app.get('/MaterializedView', guard(searchMaterializedView))
  app.get('/MaterializedView/new', guard(getNewForm))
  app.get('/MaterializedView/:id/\\$data', guard(getMaterializedViewData))
  app.get('/MaterializedView/:id', guard(getMaterializedView))
  app.put('/MaterializedView/:id', guard(putMaterializedView))
  app.delete('/MaterializedView/:id', guard(deleteMaterializedView))
}
