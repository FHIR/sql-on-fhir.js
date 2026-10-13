/**
 * HTML forms for the `$sql-run` and `$sql-export` operations. Each form is a
 * thin layer over the operation handlers: the submitted fields are assembled
 * into the same Parameters resource the API accepts and handed to
 * `runOperation` or `startExport`, and the outcome is rendered as HTML.
 *
 * Author: John Grimes
 */

import { layout } from './ui.js'
import { read, searchAll } from './db.js'
import { getBaseUrl, arrayify } from './utils.js'
import { runOperation } from './sqlRun.js'
import { startExport, loadJob } from './sqlExport.js'
import { SPEC_BASE, artifactKind, formatConcepts, operationError, issue } from './operations.js'

const RUN_FORMAT_VALUESET = `${SPEC_BASE}/ValueSet/OutputFormatCodes`
const EXPORT_FORMAT_VALUESET = `${SPEC_BASE}/ValueSet/ExportOutputFormatCodes`

/** Formats the value sets list but this server does not implement. */
const UNSUPPORTED_FORMATS = ['parquet']

/** `value[x]` field carrying each Library.parameter type. */
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

/** HTML input type used to capture each Library.parameter type. */
const PARAMETER_INPUT_TYPES = {
  integer: 'number',
  integer64: 'number',
  decimal: 'number',
  boolean: 'checkbox',
  date: 'date',
  dateTime: 'datetime-local',
  instant: 'datetime-local',
  time: 'time',
}

const DEFAULT_INLINE_VIEW = {
  resourceType: 'ViewDefinition',
  name: 'inline_patients',
  status: 'active',
  resource: 'Patient',
  select: [
    {
      column: [
        { name: 'id', path: 'getResourceKey()', type: 'id' },
        { name: 'gender', path: 'gender', type: 'code' },
        { name: 'birth_date', path: 'birthDate', type: 'date' },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isHtmx(req) {
  return Boolean(req.headers['hx-request'])
}

function sendHtml(req, res, html) {
  res.setHeader('Content-Type', 'text/html')
  res.send(isHtmx(req) ? html : layout(`<div class="container mx-auto p-4">${html}</div>`))
}

function breadcrumbs(current) {
  return `
    <div class="flex items-center gap-4">
      <a href="/">Home</a>
      <span class="text-gray-500">/</span>
      <span class="text-gray-700">${escapeHtml(current)}</span>
    </div>`
}

function option(value, label, selected = false) {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
}

function field(label, control, help = '') {
  return `
    <div class="mt-3">
      <label class="block text-sm font-semibold mb-1">${escapeHtml(label)}</label>
      ${control}
      ${help ? `<p class="text-xs text-gray-500 mt-1">${help}</p>` : ''}
    </div>`
}

function section(title, body) {
  return `
    <fieldset class="mt-4 border border-gray-200 rounded p-3">
      <legend class="text-sm font-bold px-1">${escapeHtml(title)}</legend>
      ${body}
    </fieldset>`
}

function multiplyRow(control) {
  return `
    <div class="multiply-row remove-row flex items-start gap-2 py-1">
      <div class="flex-1">${control}</div>
      <a class="btn" hx-ext="multiply">+</a>
      <a class="btn" hx-ext="remove">-</a>
    </div>`
}

function jsonTextarea(name, { value = '', rows = 8, placeholder = '' } = {}) {
  return `<textarea name="${escapeHtml(name)}" rows="${rows}" class="w-full font-mono" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
}

function errorBox(title, body) {
  return `
    <div class="bg-red-50 border border-red-300 rounded p-3">
      <p class="text-sm text-red-700 font-semibold">${escapeHtml(title)}</p>
      ${body}
    </div>`
}

function renderIssues(issues) {
  return `
    <ul class="list-disc pl-4 text-sm mt-2">
      ${issues
        .map(
          (i) => `
        <li class="mt-1">
          <span class="text-red-700 font-semibold">${escapeHtml(i.severity)}</span>
          [<code>${escapeHtml(i.code)}</code>]
          ${i.expression ? `<code>${escapeHtml(i.expression.join(', '))}</code>:` : ''}
          ${escapeHtml(i.diagnostics)}
        </li>`,
        )
        .join('')}
    </ul>`
}

function renderError(err) {
  if (!err.status) console.error('Unexpected form error', err)
  const status = err.status || 500
  const issues = err.issues || [issue('exception', err.message || String(err))]
  return errorBox(`Error (HTTP ${status})`, renderIssues(issues))
}

function renderRequest(params) {
  return `
    <details class="mt-2 text-sm">
      <summary class="cursor-pointer text-gray-600">Request Parameters</summary>
      <pre class="mt-2">${escapeHtml(JSON.stringify(params, null, 2))}</pre>
    </details>`
}

// ---------------------------------------------------------------------------
// Shared controls
// ---------------------------------------------------------------------------

function subjectLabel(resource) {
  const kind = artifactKind(resource) || resource.resourceType
  return `${resource.title || resource.name || resource.id} (${kind})`
}

async function subjectSelect(config, name, { selected = '', attrs = '' } = {}) {
  const [views, libraries] = await Promise.all([
    searchAll(config, 'ViewDefinition'),
    searchAll(config, 'Library'),
  ])
  const options = [...views, ...libraries]
    .map((r) => [`${r.resourceType}/${r.id}`, subjectLabel(r)])
    .sort((a, b) => a[1].localeCompare(b[1]))
  return `
    <select name="${escapeHtml(name)}" class="w-full" ${attrs}>
      ${option('', '(none)', selected === '')}
      ${options.map(([value, label]) => option(value, label, value === selected)).join('')}
    </select>`
}

async function patientSelect(config, name) {
  const patients = await searchAll(config, 'Patient')
  const label = (p) => {
    const n = p.name?.[0]
    const text = [n?.family, ...(n?.given || [])].filter(Boolean).join(', ')
    return text ? `${text} (${p.id})` : p.id
  }
  return `
    <select name="${escapeHtml(name)}" class="w-full">
      ${option('', '(none)')}
      ${patients.map((p) => option(`Patient/${p.id}`, label(p))).join('')}
    </select>`
}

async function groupSelect(config, name) {
  const groups = await searchAll(config, 'Group')
  return `
    <select name="${escapeHtml(name)}" class="w-full">
      ${option('', '(none)')}
      ${groups.map((g) => option(`Group/${g.id}`, g.name ? `${g.name} (${g.id})` : g.id)).join('')}
    </select>`
}

async function formatSelect(config, valueSetUrl, selected) {
  const concepts = (await formatConcepts(config, valueSetUrl)).filter(
    (c) => !UNSUPPORTED_FORMATS.includes(c.code),
  )
  return `
    <select name="_format" class="w-full">
      ${concepts.map((c) => option(c.code, c.display || c.code, c.code === selected)).join('')}
    </select>`
}

function formatHelp() {
  return `${UNSUPPORTED_FORMATS.join(', ')} is defined by the specification but not supported by this server.`
}

function headerCheckbox() {
  return `<label class="text-sm"><input type="checkbox" name="header" value="true" checked/> Include a header row (csv only)</label>`
}

function sinceInput() {
  return `<input type="datetime-local" name="_since" step="1"/>`
}

// ---------------------------------------------------------------------------
// Form values to Parameters
// ---------------------------------------------------------------------------

function present(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function parseJson(text, expression) {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw operationError(400, [issue('structure', `Invalid JSON: ${err.message}`, expression)])
  }
}

/** Convert a `datetime-local` value to a FHIR instant (UTC, with seconds). */
function toInstant(value, expression) {
  const time = Date.parse(value)
  if (Number.isNaN(time))
    throw operationError(400, [issue('value', `'${value}' is not a valid date and time`, expression)])
  return new Date(time).toISOString()
}

/** The `subjectReference`, `subjectCanonical` or `subjectResource` parameters named by a set of form fields. */
function subjectParams({ stored, canonical, resource }, expression) {
  const params = []
  if (present(stored)) params.push({ name: 'subjectReference', valueReference: { reference: stored.trim() } })
  if (present(canonical)) params.push({ name: 'subjectCanonical', valueCanonical: canonical.trim() })
  if (present(resource))
    params.push({ name: 'subjectResource', resource: parseJson(resource, `${expression}subjectResource`) })
  return params
}

function repeatedResources(values, name) {
  return arrayify(values)
    .filter(present)
    .map((text, i) => ({ name, resource: parseJson(text, `${name}[${i}]`) }))
}

function repeatedReferences(values, name) {
  return arrayify(values)
    .filter(present)
    .map((reference) => ({ name, valueReference: { reference } }))
}

/** Parameters common to both operations: `_format`, `header`, `patient`, `group`, `_since`. */
function commonParams(body) {
  const params = []
  if (present(body._format)) params.push({ name: '_format', valueCode: body._format })
  params.push({ name: 'header', valueBoolean: body.header === 'true' })
  params.push(...repeatedReferences(body.patient, 'patient'))
  params.push(...repeatedReferences(body.group, 'group'))
  if (present(body._since)) params.push({ name: '_since', valueInstant: toInstant(body._since, '_since') })
  return params
}

/** Convert a form value to the typed `value[x]` of a Library parameter. */
function parameterValue(declared, raw) {
  const fieldName = PARAMETER_VALUE_FIELDS[declared.type]
  if (!fieldName) {
    throw operationError(400, [
      issue(
        'not-supported',
        `Parameter type '${declared.type}' cannot be captured by this form`,
        `parameters.${declared.name}`,
      ),
    ])
  }
  const expression = `parameters.${declared.name}`
  let value
  switch (declared.type) {
    case 'boolean':
      value = raw === 'true'
      break
    case 'integer':
      value = Number(raw)
      if (!Number.isInteger(value)) {
        throw operationError(400, [issue('value', `'${raw}' is not a valid integer`, expression)])
      }
      break
    case 'decimal':
      value = Number(raw)
      if (!Number.isFinite(value))
        throw operationError(400, [issue('value', `'${raw}' is not a valid decimal`, expression)])
      break
    case 'dateTime':
    case 'instant':
      value = toInstant(raw, expression)
      break
    default:
      value = raw
  }
  return { name: declared.name, [fieldName]: value }
}

/**
 * Build the `parameters` resource of a `$sql-run` request from the `param.<name>`
 * fields, typed against the parameters the stored Library declares.
 */
async function libraryParameters(config, body) {
  const entries = Object.entries(body).filter(([key, value]) => key.startsWith('param.') && present(value))
  if (entries.length === 0) return null
  const [type, id] = String(body.subjectStored || '').split('/')
  const library = type === 'Library' ? await read(config, 'Library', id) : null
  const declared = library?.parameter || []
  const parameter = entries.map(([key, raw]) => {
    const name = key.slice('param.'.length)
    const decl = declared.find((p) => p.name === name)
    if (!decl) {
      throw operationError(400, [
        issue('invalid', `Parameter '${name}' is not declared by the subject`, `parameters.${name}`),
      ])
    }
    return parameterValue(decl, raw)
  })
  return { resourceType: 'Parameters', parameter }
}

// ---------------------------------------------------------------------------
// $sql-run
// ---------------------------------------------------------------------------

function parameterInput(param) {
  const name = `param.${param.name}`
  const type = PARAMETER_INPUT_TYPES[param.type] || 'text'
  const step =
    param.type === 'decimal'
      ? ' step="any"'
      : param.type === 'dateTime' || param.type === 'instant'
        ? ' step="1"'
        : ''
  const control =
    type === 'checkbox'
      ? `<label class="text-sm"><input type="checkbox" name="${escapeHtml(name)}" value="true"/> true</label>`
      : `<input type="${type}" name="${escapeHtml(name)}"${step} class="w-full"/>`
  return field(`${param.name} (${param.type})`, control, escapeHtml(param.documentation || ''))
}

/** Fields for the input parameters a Library declares; empty for any other subject. */
async function renderParameterFields(config, subject) {
  const [type, id] = String(subject || '').split('/')
  if (type !== 'Library') return ''
  const library = await read(config, 'Library', id)
  const inputs = (library?.parameter || []).filter((p) => p.use !== 'out')
  if (inputs.length === 0)
    return `<p class="text-xs text-gray-500 mt-3">This Library declares no input parameters.</p>`
  return section('Library parameters', inputs.map(parameterInput).join(''))
}

async function renderRunForm(req) {
  const config = req.config
  const preselected = typeof req.query.subject === 'string' ? req.query.subject : ''
  const clearOthers = `onchange="const f=this.form;f.subjectCanonical.value='';f.subjectResource.value=''"`
  const [subjects, parameterFields, patients, groups, formats] = await Promise.all([
    subjectSelect(config, 'subjectStored', {
      selected: preselected,
      attrs: `hx-get="/$sql-run/form/parameters" hx-target="#parameter-fields" hx-swap="innerHTML" ${clearOthers}`,
    }),
    renderParameterFields(config, preselected),
    patientSelect(config, 'patient'),
    groupSelect(config, 'group'),
    formatSelect(config, RUN_FORMAT_VALUESET, 'json'),
  ])
  const inlineDefault = preselected ? '' : JSON.stringify(DEFAULT_INLINE_VIEW, null, 2)
  return `
    ${breadcrumbs('$sql-run')}
    <h1 class="mt-4 text-2xl font-bold">$sql-run</h1>
    <p class="mt-2 text-sm text-gray-600">Evaluate a ViewDefinition, SQLQuery Library or SQLView Library synchronously and view the rows it produces.</p>
    <div class="mt-4 flex gap-4">
      <div class="flex-1">
        <form hx-post="/$sql-run/form" hx-target="#run-result" hx-swap="innerHTML">
          ${section(
            'Subject',
            `<p class="text-xs text-gray-500">Supply exactly one of the three.</p>
            ${field('Stored subject (subjectReference)', subjects, 'Choosing a stored subject clears the other two fields.')}
            ${field('subjectCanonical', `<input type="text" name="subjectCanonical" class="w-full" placeholder="http://example.org/ViewDefinition/x|1.0"/>`)}
            ${field('subjectResource', jsonTextarea('subjectResource', { value: inlineDefault, rows: 12, placeholder: 'Inline ViewDefinition or Library JSON' }))}
            <div id="parameter-fields">${parameterFields}</div>`,
          )}
          ${section(
            'Supporting artifacts',
            `${field('context', multiplyRow(jsonTextarea('context', { rows: 4, placeholder: 'ViewDefinition, SQLView Library, ValueSet or ConceptMap JSON this subject depends on' })))}
            ${field('resource', multiplyRow(jsonTextarea('resource', { rows: 4, placeholder: 'FHIR resource or Bundle to evaluate instead of the stored data (ViewDefinition subjects only)' })))}`,
          )}
          ${section(
            'Output and filters',
            `${field('_format', formats, formatHelp())}
            ${field('header', headerCheckbox())}
            ${field('patient', multiplyRow(patients))}
            ${field('group', groups)}
            ${field('_since', sinceInput())}
            ${field('_limit', `<input type="number" name="_limit" min="0"/>`)}`,
          )}
          <div class="mt-4">
            <button type="submit" class="btn">Run</button>
          </div>
        </form>
      </div>
      <div class="flex-1">
        <p class="text-sm font-semibold mb-1">Result</p>
        <div id="run-result" class="border border-gray-200 rounded p-3 min-h-12 text-sm overflow-x-auto"></div>
      </div>
    </div>`
}

async function runParameters(config, body) {
  const parameter = [
    ...subjectParams(
      { stored: body.subjectStored, canonical: body.subjectCanonical, resource: body.subjectResource },
      '',
    ),
  ]
  const parameters = await libraryParameters(config, body)
  if (parameters) parameter.push({ name: 'parameters', resource: parameters })
  parameter.push(...repeatedResources(body.context, 'context'))
  parameter.push(...repeatedResources(body.resource, 'resource'))
  parameter.push(...commonParams(body))
  if (present(body._limit)) parameter.push({ name: '_limit', valueInteger: Number(body._limit) })
  return { resourceType: 'Parameters', parameter }
}

function renderRows(body) {
  const rows = JSON.parse(body)
  if (!Array.isArray(rows) || rows.length === 0) return `<p class="text-sm text-gray-600 mt-2">No rows.</p>`
  const columns = []
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  const cell = (v) =>
    v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return `
    <p class="text-sm text-gray-600 mt-2">${rows.length} row${rows.length === 1 ? '' : 's'}</p>
    <table class="mt-2">
      <thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(cell(r[c]))}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>`
}

function renderRunResult(params, result) {
  const body =
    result.format === 'json' ? renderRows(result.body) : `<pre class="mt-2">${escapeHtml(result.body)}</pre>`
  return `
    <p class="text-sm text-green-700 font-semibold">HTTP 200 <span class="text-gray-500 font-normal">${escapeHtml(result.contentType)}</span></p>
    ${renderRequest(params)}
    ${body}`
}

/**
 * `GET /$sql-run/form`: the form. `?subject=ViewDefinition/<id>` or
 * `?subject=Library/<id>` preselects that stored subject.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 */
export async function getRunForm(req, res) {
  sendHtml(req, res, await renderRunForm(req))
}

/**
 * `GET /$sql-run/form/parameters?subject=Library/<id>`: fragment with one
 * field per input parameter of the chosen Library. htmx sends the dropdown's
 * own field, so `subjectStored` is accepted as an alias of `subject`.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 */
export async function getRunParameterFields(req, res) {
  res.setHeader('Content-Type', 'text/html')
  res.send(await renderParameterFields(req.config, req.query.subject ?? req.query.subjectStored))
}

/**
 * `POST /$sql-run/form`: build the Parameters resource from the form fields,
 * run the operation and render the outcome.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 */
export async function postRunForm(req, res) {
  let params = null
  try {
    params = await runParameters(req.config, req.body)
    const result = await runOperation(req.config, params, { baseUrl: getBaseUrl(req), accept: undefined })
    sendHtml(req, res, renderRunResult(params, result))
  } catch (err) {
    sendHtml(req, res, `${renderError(err)}${params ? renderRequest(params) : ''}`)
  }
}

// ---------------------------------------------------------------------------
// $sql-export
// ---------------------------------------------------------------------------

async function renderSubjectRow(config) {
  return multiplyRow(`
    <div class="border border-gray-200 rounded p-2">
      ${field('name', `<input type="text" name="subjectName[]" class="w-full" placeholder="Output name (defaults to the artifact name)"/>`)}
      ${field('Stored subject (subjectReference)', await subjectSelect(config, 'subjectStored[]'))}
      ${field('subjectCanonical', `<input type="text" name="subjectCanonical[]" class="w-full" placeholder="http://example.org/ViewDefinition/x|1.0"/>`)}
      ${field('subjectResource', jsonTextarea('subjectResource[]', { rows: 4, placeholder: 'Inline ViewDefinition or Library JSON' }))}
      ${field('parameters', jsonTextarea('subjectParameters[]', { rows: 3, placeholder: '{"resourceType": "Parameters", "parameter": [...]} (Library subjects only)' }))}
    </div>`)
}

async function renderExportForm(req) {
  const config = req.config
  const [subjectRow, patients, groups, formats] = await Promise.all([
    renderSubjectRow(config),
    patientSelect(config, 'patient'),
    groupSelect(config, 'group'),
    formatSelect(config, EXPORT_FORMAT_VALUESET, 'csv'),
  ])
  return `
    ${breadcrumbs('$sql-export')}
    <h1 class="mt-4 text-2xl font-bold">$sql-export</h1>
    <p class="mt-2 text-sm text-gray-600">Export one or more subjects asynchronously. The status panel polls the job until it completes, fails or is cancelled.</p>
    <div class="mt-4 flex gap-4">
      <div class="flex-1">
        <form hx-post="/$sql-export/form" hx-target="#export-result" hx-swap="innerHTML">
          ${section('Subjects', `<p class="text-xs text-gray-500">Each row supplies exactly one of stored subject, subjectCanonical or subjectResource.</p>${subjectRow}`)}
          ${section(
            'Supporting artifacts',
            field(
              'context',
              multiplyRow(
                jsonTextarea('context', {
                  rows: 4,
                  placeholder:
                    'ViewDefinition, SQLView Library, ValueSet or ConceptMap JSON the subjects depend on',
                }),
              ),
            ),
          )}
          ${section(
            'Output and filters',
            `${field('clientTrackingId', `<input type="text" name="clientTrackingId" class="w-full"/>`)}
            ${field('_format', formats, formatHelp())}
            ${field('header', headerCheckbox())}
            ${field('patient', multiplyRow(patients))}
            ${field('group', groups)}
            ${field('_since', sinceInput())}`,
          )}
          <div class="mt-4">
            <button type="submit" class="btn">Export</button>
          </div>
        </form>
      </div>
      <div class="flex-1">
        <p class="text-sm font-semibold mb-1">Status</p>
        <div id="export-result" class="border border-gray-200 rounded p-3 min-h-12 text-sm overflow-x-auto"></div>
      </div>
    </div>`
}

function exportParameters(body) {
  // `express.urlencoded({ extended: true })` strips the `[]` suffix and yields arrays.
  const names = arrayify(body.subjectName)
  const stored = arrayify(body.subjectStored)
  const canonicals = arrayify(body.subjectCanonical)
  const resources = arrayify(body.subjectResource)
  const parameters = arrayify(body.subjectParameters)
  const count = Math.max(names.length, stored.length, canonicals.length, resources.length, parameters.length)
  const parameter = []
  for (let i = 0; i < count; i++) {
    const part = subjectParams(
      { stored: stored[i], canonical: canonicals[i], resource: resources[i] },
      `subject[${i}].`,
    )
    if (part.length === 0 && !present(names[i]) && !present(parameters[i])) continue
    if (present(names[i])) part.unshift({ name: 'name', valueString: names[i].trim() })
    if (present(parameters[i])) {
      part.push({ name: 'parameters', resource: parseJson(parameters[i], `subject[${i}].parameters`) })
    }
    parameter.push({ name: 'subject', part })
  }
  parameter.push(...repeatedResources(body.context, 'context'))
  if (present(body.clientTrackingId))
    parameter.push({ name: 'clientTrackingId', valueString: body.clientTrackingId.trim() })
  parameter.push(...commonParams(body))
  return { resourceType: 'Parameters', parameter }
}

const STATUS_CLASSES = {
  accepted: 'text-blue-700',
  'in-progress': 'text-blue-700',
  completed: 'text-green-700',
  failed: 'text-red-700',
  cancelled: 'text-gray-700',
}

function renderOutputs(job) {
  if (job.outputs.length === 0)
    return `<p class="text-sm text-gray-600 mt-2">The export produced no output files.</p>`
  return `
    <table class="mt-2">
      <thead><tr><th>Output</th><th>File</th></tr></thead>
      <tbody>
        ${job.outputs
          .map((o) => {
            const href = `${job.baseUrl}/$sql-export/${job.exportId}/${o.file}`
            return `<tr><td>${escapeHtml(o.name)}</td><td><a href="${escapeHtml(href)}">${escapeHtml(o.file)}</a></td></tr>`
          })
          .join('')}
      </tbody>
    </table>
    <p class="text-xs text-gray-500 mt-2">Manifest: <a href="${escapeHtml(`${job.baseUrl}/$sql-export/${job.exportId}/result`)}">result</a></p>`
}

/** The status panel for a job; polls itself while the job is still running. */
function renderStatusPanel(job) {
  const running = job.status === 'accepted' || job.status === 'in-progress'
  const statusUrl = `/$sql-export/${job.exportId}/status`
  const polling = running
    ? `hx-get="/$sql-export/form/status/${job.exportId}" hx-trigger="every 2s" hx-swap="outerHTML"`
    : ''
  let detail = ''
  if (running) {
    detail = `
      <p class="text-sm mt-2">Progress: ${job.outputs.length}/${job.subjects.length} subjects <span class="text-gray-500">(refreshing every 2 s)</span></p>
      <div class="mt-2">
        <a class="btn" hx-delete="${statusUrl}" hx-swap="none">Cancel</a>
      </div>`
  } else if (job.status === 'completed') {
    detail = renderOutputs(job)
  } else if (job.status === 'failed') {
    detail = errorBox(
      `Export failed (HTTP ${job.error?.status || 500})`,
      renderIssues(job.error?.issues || []),
    )
  } else {
    detail = `<p class="text-sm text-gray-600 mt-2">The export was cancelled and its files removed.</p>`
  }
  return `
    <div id="export-status" ${polling}>
      <p class="text-sm">
        <span class="${STATUS_CLASSES[job.status] || ''} font-semibold">${escapeHtml(job.status)}</span>
        <span class="text-gray-500">export</span> <code>${escapeHtml(job.exportId)}</code>
        ${job.clientTrackingId ? `<span class="text-gray-500">tracking</span> <code>${escapeHtml(job.clientTrackingId)}</code>` : ''}
      </p>
      <p class="text-xs text-gray-500 mt-1">Started ${escapeHtml(job.startTime)}${job.endTime ? `, ended ${escapeHtml(job.endTime)}` : ''}</p>
      <p class="text-xs text-gray-500 mt-1">Status URL: <a href="${escapeHtml(statusUrl)}">${escapeHtml(statusUrl)}</a></p>
      ${detail}
    </div>`
}

/**
 * `GET /$sql-export/form`: the form.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 */
export async function getExportForm(req, res) {
  sendHtml(req, res, await renderExportForm(req))
}

/**
 * `POST /$sql-export/form`: build the Parameters resource, start the export
 * and render the status panel, which then polls the job.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 */
export async function postExportForm(req, res) {
  let params = null
  try {
    params = exportParameters(req.body)
    const job = await startExport(req.config, params, getBaseUrl(req))
    sendHtml(req, res, `${renderStatusPanel(job)}${renderRequest(params)}`)
  } catch (err) {
    sendHtml(req, res, `${renderError(err)}${params ? renderRequest(params) : ''}`)
  }
}

/**
 * `GET /$sql-export/form/status/:id`: the status panel fragment for a job.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 */
export function getExportStatusPanel(req, res) {
  const job = loadJob(req.config, req.params.id)
  res.setHeader('Content-Type', 'text/html')
  if (!job) {
    res.status(404)
    res.send(
      `<div id="export-status">${errorBox('Not found', `<p class="text-xs text-red-600 mt-1">Export '${escapeHtml(req.params.id)}' does not exist.</p>`)}</div>`,
    )
    return
  }
  res.send(renderStatusPanel(job))
}

/**
 * Mount the form routes. `$` is escaped so Express does not read it as a
 * pattern character.
 *
 * @param {object} app - Express application.
 */
export function mountRoutes(app) {
  app.get('/\\$sql-run/form', getRunForm)
  app.post('/\\$sql-run/form', postRunForm)
  app.get('/\\$sql-run/form/parameters', getRunParameterFields)
  app.get('/\\$sql-export/form', getExportForm)
  app.post('/\\$sql-export/form', postExportForm)
  app.get('/\\$sql-export/form/status/:id', getExportStatusPanel)
}
