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
import { materializeRefToRows, resolveDependency, logicalDependencyRefs } from './sql.js'
import { search, run, get, all } from './db.js'
import {
  layout,
  escapeHtml,
  breadcrumb,
  statusPill,
  tableIcon,
  listSection,
  rowsTable,
  FORM_INPUT,
  formField,
  legend,
  pageHeader,
  emptyState,
} from './ui.js'
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

function mvRow(mv) {
  return `
      <li class="group flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
        ${tableIcon()}
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

const mvGroup = (destination, items) => listSection(destination, items, 'relation', mvRow)

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
    : emptyState(
        'No materializations yet. <a href="/MaterializedView/new" class="text-blue-600 hover:underline">Create one</a>.',
      )
  return layout(`
    <div class="container mx-auto p-4 max-w-4xl">
      ${breadcrumb('<span>Materialized Views</span>')}
      ${pageHeader('Materialized Views', '<a href="/MaterializedView/new" class="btn">New</a>')}
      ${body}
    </div>`)
}

const DESTINATION_LABELS = {
  sqlite: 'sqlite — a SQLite table',
  csv: 'csv — a CSV file',
}

// The Name field + dependency preview, re-rendered by htmx when the view or
// destination changes. Name is derived from the view; the preview shows the
// logical dependencies that will be cascaded onto the destination and whether
// each is already materialized there (reused) or will be built.
async function renderDerivedFields(config, viewRef, destination) {
  const db = config.db
  await ensureMvTable(db)
  const resolved = viewRef ? await resolveDependency(config, viewRef) : null
  const name = resolved ? sanitizeIdent(deriveName(resolved.resource.url || viewRef)) : ''

  let depsHtml = `<p class="text-sm text-gray-500">No dependencies — a single relation.</p>`
  if (resolved) {
    const refs = logicalDependencyRefs(resolved.resource)
    if (refs.length) {
      const items = []
      for (const ref of refs) {
        const dep = await resolveDependency(config, ref)
        const existing = dep ? await findMaterialization(db, dep.resource, destination) : null
        const state = existing
          ? `<span class="text-gray-500 text-xs">already materialized — reused</span>`
          : `<span class="text-blue-600 text-xs">will be materialized</span>`
        items.push(`
          <li class="flex items-center gap-2 text-sm py-0.5">
            ${tableIcon('w-3.5 h-3.5 text-gray-400 shrink-0')}
            <span class="font-mono text-xs truncate" title="${escapeHtml(ref)}">${escapeHtml(ref)}</span>
            ${state}
          </li>`)
      }
      depsHtml = `<ul class="border border-gray-200 rounded-md p-3">${items.join('')}</ul>`
    }
  }

  return `
    ${formField('Name', '(optional) relation name; derived from the view — edit to override', `<input name="name" value="${escapeHtml(name)}" class="${FORM_INPUT}" placeholder="e.g. patients" />`)}
    <div>
      <label class="block font-semibold mb-1">Dependencies
        <span class="text-gray-400 font-normal text-sm">— cascaded onto <code>${escapeHtml(destination)}</code> in topological order</span>
      </label>
      ${depsHtml}
    </div>`
}

async function htmlNewForm(config, views) {
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

  // Initial derived fields for the first view + default destination.
  const firstView = views[0]?.value || ''
  const derived = await renderDerivedFields(config, firstView, DEFAULT_DESTINATION)

  // htmx: re-render #mv-derived whenever the view or destination changes.
  const hx = `hx-get="/MaterializedView/new/fields" hx-target="#mv-derived" hx-swap="innerHTML" hx-trigger="change"`

  return layout(`
    <div class="container mx-auto p-4 max-w-2xl">
      ${breadcrumb('<a href="/MaterializedView" class="text-blue-500">Materialized Views</a>', '<span>New</span>')}
      <h1 class="mt-4 text-2xl font-bold">New Materialized View</h1>
      <form method="post" action="/MaterializedView" class="mt-4 space-y-5">

        <fieldset class="space-y-4">
          ${legend(`Identity`)}
          ${formField('View', '(required) — the ViewDefinition / SQLView to materialize', `<select name="view" class="${FORM_INPUT}" ${hx} hx-include="[name='destination']">${opts}</select>`)}
          ${formField('Destination', 'where the relation lives — one materialization per (view, destination)', `<select name="destination" class="${FORM_INPUT}" ${hx} hx-include="[name='view']">${destOpts}</select>`)}
          <div id="mv-derived" class="space-y-4">${derived}</div>
          ${formField('Identifier', '(optional) business identifier', `<div class="flex gap-2"><input name="identifier_system" class="${FORM_INPUT}" placeholder="system (uri)" /><input name="identifier_value" class="${FORM_INPUT}" placeholder="value" /></div>`)}
        </fieldset>

        <fieldset class="space-y-4">
          ${legend(`Type &amp; freshness`)}
          ${formField('Type', '(optional) materialization kind/format — vendor-extensible; defaults to the destination kind', `<div class="flex gap-2"><input name="type_system" class="${FORM_INPUT}" placeholder="system (e.g. postgres)" /><input name="type_code" class="${FORM_INPUT}" placeholder="code (e.g. unlogged-table, parquet)" /></div>`)}
          ${formField('Staleness', 'freshness target — how far the relation may lag; blank = on-demand, 0 = live', `<div class="flex gap-2"><input name="staleness_value" type="number" min="0" step="1" class="${FORM_INPUT}" placeholder="value" /><select name="staleness_unit" class="${FORM_INPUT}">${unitOpts}</select></div>`)}
        </fieldset>

        <p class="text-xs text-gray-400">
          <span class="font-semibold">status</span>, <span class="font-semibold">refreshedAt</span>,
          <span class="font-semibold">rowCount</span> and <span class="font-semibold">error</span> are
          server-managed and set on build. Dependencies are resolved automatically; pin specific
          upstreams via the API's <code>dependsOn</code> if needed.
        </p>

        <button type="submit" class="btn">Materialize</button>
      </form>
    </div>`)
}

// Resolve a materialization's dependsOn graph into a tree of records (for
// display). Cycle-guarded via `seen`.
async function buildDepTree(db, mv, seen = new Set()) {
  const children = []
  for (const dep of mv.dependsOn || []) {
    const id = (dep.reference || '').split('/').pop()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const child = await readRecord(db, id)
    if (child) children.push(await buildDepTree(db, child, seen))
  }
  return { mv, children }
}

// Render one dependency node (and its subtree) as a nested list item.
function depNode(node) {
  const mv = node.mv
  const kids = node.children.length
    ? `<ul class="ml-4 border-l border-gray-200 pl-3 mt-1">${node.children.map(depNode).join('')}</ul>`
    : ''
  return `
      <li class="py-1">
        <div class="flex items-center gap-2 text-sm">
          ${tableIcon('w-3.5 h-3.5 text-gray-400 shrink-0')}
          <a href="/MaterializedView/${mv.id}/$data" class="font-mono text-blue-600 hover:underline">${escapeHtml(mv.name)}</a>
          <span class="text-gray-400 text-xs truncate" title="${escapeHtml(mv.view)}">${escapeHtml(mv.view)}</span>
          ${statusPill(mv.status)}
          <span class="text-gray-400 text-xs tabular-nums">${mv.rowCount ?? ''} rows</span>
        </div>
        ${kids}
      </li>`
}

function renderDepTree(tree) {
  if (!tree.children.length) return ''
  return `
    <section class="mt-6">
      <div class="flex items-center gap-2 mb-2">
        <span class="px-2 py-0.5 rounded bg-slate-100 font-mono text-sm font-semibold">dependencies</span>
        <span class="text-gray-400 text-sm">upstream materializations on this destination</span>
      </div>
      <ul class="border border-gray-200 rounded-md p-3">
        ${tree.children.map(depNode).join('')}
      </ul>
    </section>`
}

function htmlData(mv, rows, depTree) {
  return layout(`
    <div class="container mx-auto p-4 max-w-4xl">
      ${breadcrumb('<a href="/MaterializedView" class="text-blue-500">Materialized Views</a>', `<span>${escapeHtml(mv.name)}</span>`)}
      <h1 class="mt-4 text-2xl font-bold">
        ${escapeHtml(mv.destination)}.${escapeHtml(mv.name)}
        <span class="text-sm font-normal text-gray-500">— ${mv.rowCount} rows · ${mv.status} · ${escapeHtml(mv.view)}</span>
      </h1>
      ${depTree ? renderDepTree(depTree) : ''}
      <h2 class="mt-6 text-sm font-semibold text-gray-500 uppercase tracking-wide">Data</h2>
      ${rowsTable(rows)}
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

// ---- build / cascade --------------------------------------------------------

// Candidate view identifiers a materialization may be registered under.
function viewCandidates(view) {
  return [view.url, view.id && `${view.resourceType}/${view.id}`].filter(Boolean)
}

// Find an existing materialization of `view` on `destination` (matched by
// canonical url or typed ref), or null.
async function findMaterialization(db, view, destination) {
  const candidates = viewCandidates(view)
  if (!candidates.length) return null
  const ph = candidates.map(() => '?').join(', ')
  const row = await get(db, `SELECT resource FROM ${MV_TABLE} WHERE view IN (${ph}) AND destination = ?`, [
    ...candidates,
    destination,
  ])
  return row ? JSON.parse(row.resource) : null
}

// Pick a relation name for `name` on `destination` that is free, appending a
// short suffix if a different view already claims it.
async function uniqueName(db, destination, name) {
  let candidate = name
  for (let i = 2; ; i++) {
    const taken = await get(db, `SELECT id FROM ${MV_TABLE} WHERE destination = ? AND name = ?`, [
      destination,
      candidate,
    ])
    if (!taken) return candidate
    candidate = `${name}_${i}`
  }
}

// Build a relation for a view on a destination and insert its MaterializedView
// record. Logical dependencies are materialized first (topological), unless the
// caller pins `dependsOn` explicitly.
async function buildMaterialization(config, { viewRef, view, destination, name, extra = {}, stack }) {
  const db = config.db

  // 1. Resolve dependencies: honour explicit pins, else cascade the logical DAG.
  let dependsOn = extra.dependsOn
  if (!dependsOn) {
    const depRecords = []
    for (const depRef of logicalDependencyRefs(view)) {
      depRecords.push(await ensureMaterialized(config, depRef, destination, stack))
    }
    dependsOn = depRecords.map((r) => ({ reference: `MaterializedView/${r.id}` }))
  }

  // 2. Build this relation.
  const built = await materializeRefToRows(config, viewRef)
  await buildRelation(db, destination, name, built.columns, built.rows)

  // 3. Insert the record.
  const id = `mv-${randomUUID().slice(0, 8)}`
  const resource = {
    resourceType: 'MaterializedView',
    id,
    ...(extra.identifier ? { identifier: extra.identifier } : {}),
    view: viewRef,
    destination,
    name,
    type: extra.type || {
      system: 'http://sql-on-fhir.org/materialize',
      code: DESTINATIONS[destination].kind,
    },
    ...(extra.staleness ? { staleness: extra.staleness } : {}),
    ...(dependsOn && dependsOn.length ? { dependsOn } : {}),
    status: 'ready',
    refreshedAt: new Date().toISOString(),
    rowCount: built.rows.length,
  }
  await run(
    db,
    `INSERT INTO ${MV_TABLE} (id, view, destination, name, status, resource) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, viewRef, destination, name, 'ready', JSON.stringify(resource)],
  )
  return resource
}

// Ensure a view (given by ref) is materialized on a destination: reuse an
// existing materialization or create one, cascading its dependencies. Cycle-
// guarded via `stack` (a Set of view keys on the current path).
async function ensureMaterialized(config, ref, destination, stack) {
  const db = config.db
  const resolved = await resolveDependency(config, ref)
  if (!resolved) {
    throw Object.assign(new Error(`View not found: ${ref}`), { status: 404, code: 'not-found' })
  }
  const view = resolved.resource
  const existing = await findMaterialization(db, view, destination)
  if (existing) return existing

  const key = view.url || `${view.resourceType}/${view.id}`
  if (stack.has(key)) {
    throw Object.assign(new Error(`Dependency cycle detected at ${key}`), {
      status: 422,
      code: 'cycle',
    })
  }
  stack.add(key)
  try {
    const name = await uniqueName(db, destination, sanitizeIdent(deriveName(key)))
    return await buildMaterialization(config, { viewRef: key, view, destination, name, stack })
  } finally {
    stack.delete(key)
  }
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

    // Resolve the view so its logical dependencies can be cascaded onto the
    // same destination (the DAG is built in topological order, deps first).
    const resolved = await resolveDependency(config, view)
    if (!resolved) return sendError(req, res, 404, 'not-found', `View not found: ${view}`)

    const input = normalizeInput(body)
    const resource = await buildMaterialization(config, {
      viewRef: view,
      view: resolved.resource,
      destination,
      name,
      extra: input,
      stack: new Set([resolved.resource.url || `${resolved.resource.resourceType}/${resolved.resource.id}`]),
    })
    if (isHtml(req)) return res.redirect(303, '/MaterializedView')
    res.setHeader('Location', `/MaterializedView/${resource.id}`)
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
  res.send(await htmlNewForm(req.config, views))
}

// htmx fragment: derived Name + dependency preview for the chosen view/destination.
async function getNewFields(req, res) {
  const view = req.query.view || ''
  const destination = req.query.destination || DEFAULT_DESTINATION
  res.setHeader('Content-Type', 'text/html')
  res.send(await renderDerivedFields(req.config, view, destination))
}

async function getMaterializedViewData(req, res) {
  const db = req.config.db
  await ensureMvTable(db)
  const mv = await readRecord(db, req.params.id)
  if (!mv) return sendError(req, res, 404, 'not-found', `MaterializedView/${req.params.id} not found`)
  const rows = await readRelation(db, mv.destination, mv.name)
  if (isHtml(req)) {
    const depTree = await buildDepTree(db, mv)
    res.setHeader('Content-Type', 'text/html')
    return res.send(htmlData(mv, rows, depTree))
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
  app.get('/MaterializedView/new/fields', guard(getNewFields))
  app.get('/MaterializedView/:id/\\$data', guard(getMaterializedViewData))
  app.get('/MaterializedView/:id', guard(getMaterializedView))
  app.put('/MaterializedView/:id', guard(putMaterializedView))
  app.delete('/MaterializedView/:id', guard(deleteMaterializedView))
}
