/**
 * The `$sql-export` operation: asynchronous export of one or more subjects
 * (ViewDefinitions, SQLQuery Libraries and SQLView Libraries) as a single job,
 * following the FHIR Asynchronous Interaction Request Pattern.
 *
 * Job state lives in `<exportDir>/<exportId>/job.json` alongside the output
 * files, so completed jobs survive a restart. Jobs still running when the
 * server stops are marked failed on the next start.
 *
 * Author: John Grimes
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { getBaseUrl } from './utils.js'
import {
  EXPORT_FORMATS,
  MEDIA_TYPES,
  requireParameters,
  checkParameterNames,
  paramsNamed,
  value,
  valueOf,
  negotiateFormat,
  resolveSubject,
  resolveGraph,
  lookupCanonical,
  resolvePatientFilter,
  makeDataSource,
  applySince,
  executeSubject,
  formatRows,
  combineErrors,
  operationError,
  issue,
  fail,
  outcome,
  sendError,
} from './operations.js'
import { bindParameters } from './sqlEngine.js'

/** Input parameters of `$sql-export` as supported by this server. */
export const EXPORT_PARAMETERS = {
  subject: { type: 'complex', max: '*' },
  context: { type: 'resource', max: '*' },
  clientTrackingId: { type: 'string', max: '1' },
  _format: { type: 'code', max: '1' },
  header: { type: 'boolean', max: '1' },
  patient: { type: 'Reference', max: '*' },
  group: { type: 'Reference', max: '*' },
  _since: { type: 'instant', max: '1' },
}

const SUBJECT_PARTS = ['name', 'subjectCanonical', 'subjectReference', 'subjectResource', 'parameters']

// Jobs currently running in this process, keyed by exportId. Holds the live
// cancellation flag; everything else is read back from job.json.
const running = new Map()

// ---------------------------------------------------------------------------
// Job persistence
// ---------------------------------------------------------------------------

function jobDir(config, exportId) {
  return path.join(config.exportDir, exportId)
}

function jobFile(config, exportId) {
  return path.join(jobDir(config, exportId), 'job.json')
}

function saveJob(config, job) {
  fs.mkdirSync(jobDir(config, job.exportId), { recursive: true })
  fs.writeFileSync(jobFile(config, job.exportId), JSON.stringify(job, null, 2))
}

/**
 * Read a job record from disk.
 *
 * @param {object} config - Server config carrying `exportDir`.
 * @param {string} exportId - The job identifier.
 * @returns {object|null} the job, or null when the id is malformed or unknown.
 */
export function loadJob(config, exportId) {
  if (!/^[A-Za-z0-9-]+$/.test(exportId)) return null
  const file = jobFile(config, exportId)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Mark every job left `accepted` or `in-progress` by a previous process as
 * failed. Called once at start-up.
 *
 * @param {object} config - Server config carrying `exportDir`.
 */
export function recoverJobs(config) {
  if (!fs.existsSync(config.exportDir)) return
  for (const entry of fs.readdirSync(config.exportDir)) {
    const job = loadJob(config, entry)
    if (job && (job.status === 'accepted' || job.status === 'in-progress')) {
      job.status = 'failed'
      job.endTime = new Date().toISOString()
      job.error = {
        status: 500,
        issues: [issue('exception', 'The server restarted before the export completed')],
      }
      saveJob(config, job)
    }
  }
}

// ---------------------------------------------------------------------------
// Kick-off
// ---------------------------------------------------------------------------

function statusUrl(baseUrl, exportId) {
  return `${baseUrl}/$sql-export/${exportId}/status`
}

function resultUrl(baseUrl, exportId) {
  return `${baseUrl}/$sql-export/${exportId}/result`
}

// Output files live in their own directory so that no output name can collide
// with job.json. Names are sanitised for the file system; the sanitised names
// are checked for uniqueness at kick-off.
const FILES_DIR = 'files'

function fileNameFor(name, format) {
  return `${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.${format}`
}

function outputPath(config, exportId, file) {
  return path.join(jobDir(config, exportId), FILES_DIR, file)
}

/**
 * A data source that yields one empty resource of the requested type, so that a
 * subject can be executed at kick-off to surface schema, FHIRPath and SQL
 * errors without reading any data.
 */
function probeDataSource(resourceType) {
  return Promise.resolve([{ resourceType, id: 'probe' }])
}

/**
 * Validate one `subject` repetition and resolve its artifact.
 */
async function prepareSubject(config, part, index, baseUrl) {
  const prefix = `subject[${index}].`
  for (const p of part.part || []) {
    if (!SUBJECT_PARTS.includes(p.name)) {
      fail(400, 'invalid', `Unknown part '${p.name}' in subject`, `${prefix}${p.name}`)
    }
  }
  const subject = await resolveSubject(
    config,
    {
      subjectCanonical: value(part, 'subjectCanonical'),
      subjectReference: value(part, 'subjectReference'),
      subjectResource: value(part, 'subjectResource'),
    },
    { baseUrl, prefix },
  )
  const parametersResource = value(part, 'parameters')
  if (parametersResource !== undefined) {
    if (subject.kind === 'ViewDefinition') {
      fail(
        400,
        'invalid',
        "'parameters' cannot be supplied where the subject is a ViewDefinition",
        `${prefix}parameters`,
      )
    }
    // Bind now so that a bad name or type is rejected at kick-off.
    bindParameters(subject.resource, parametersResource, `${prefix}parameters`)
  }
  const name = value(part, 'name') || subject.resource.name || `output-${index + 1}`
  return { ...subject, name, parametersResource: parametersResource || null, expression: `${prefix}subject` }
}

/**
 * Validate a `$sql-export` request in full and, when it is acceptable, create
 * the job and start it.
 *
 * @param {object} config - Server config.
 * @param {object} params - The Parameters resource.
 * @param {string} baseUrl - Server base URL used in status, result and download URLs.
 * @returns {Promise<object>} the job record.
 * @throws {Error} with `status` and `issues` for every rejection the specification defines.
 */
export async function startExport(config, params, baseUrl) {
  checkParameterNames(params, EXPORT_PARAMETERS, { invalid: ['_limit', 'resource'] })
  const format = negotiateFormat({
    format: value(params, '_format'),
    accept: undefined,
    allowed: EXPORT_FORMATS,
    useAccept: false,
    invalid: { fhir: 'invalid' },
  })

  const subjectParts = paramsNamed(params, 'subject')
  if (subjectParts.length === 0) fail(400, 'required', "At least one 'subject' must be supplied", 'subject')

  const errors = []
  const subjects = []
  for (let i = 0; i < subjectParts.length; i++) {
    try {
      subjects.push(await prepareSubject(config, subjectParts[i], i, baseUrl))
    } catch (err) {
      errors.push(err)
    }
  }
  const names = new Set()
  const files = new Set()
  for (const s of subjects) {
    const file = fileNameFor(s.name, format)
    if (names.has(s.name) || files.has(file)) {
      errors.push(
        operationError(400, [
          issue('invalid', `Two subject repetitions would produce the output name '${s.name}'`, 'subject'),
        ]),
      )
    }
    names.add(s.name)
    files.add(file)
  }
  let patientRefs = null
  try {
    patientRefs = await resolvePatientFilter(config, {
      patients: paramsNamed(params, 'patient').map(valueOf),
      groups: paramsNamed(params, 'group').map(valueOf),
    })
  } catch (err) {
    errors.push(err)
  }
  const since = value(params, '_since') || null
  try {
    // A malformed instant is a kick-off rejection, not a job failure.
    applySince([], since)
  } catch (err) {
    errors.push(err)
  }
  const combined = combineErrors(errors)
  if (combined) throw combined

  const graph = await resolveGraph({
    subjects,
    context: paramsNamed(params, 'context').map(valueOf),
    lookup: (url, version) => lookupCanonical(config, url, version),
  })

  // A conformant subject that cannot be processed (SQL syntax error, invalid
  // FHIRPath) is rejected here rather than surfacing at the result URL.
  const probeErrors = []
  for (const subject of subjects) {
    try {
      await executeSubject({
        subject,
        graph,
        dataSource: probeDataSource,
        parametersResource: subject.parametersResource,
        expression: subject.expression,
      })
    } catch (err) {
      probeErrors.push(err)
    }
  }
  const probeCombined = combineErrors(probeErrors)
  if (probeCombined) throw probeCombined

  const exportId = randomUUID()
  const job = {
    exportId,
    clientTrackingId: value(params, 'clientTrackingId') || null,
    status: 'accepted',
    format,
    header: value(params, 'header') !== false,
    since,
    patientRefs: patientRefs ? [...patientRefs] : null,
    baseUrl,
    startTime: new Date().toISOString(),
    endTime: null,
    subjects: subjects.map((s) => ({
      name: s.name,
      kind: s.kind,
      url: s.resource.url || null,
      id: s.resource.id || null,
    })),
    outputs: [],
    error: null,
  }
  saveJob(config, job)
  running.set(exportId, { cancelled: false })
  setImmediate(() => runJob(config, job, subjects, graph))
  return job
}

async function runJob(config, job, subjects, graph) {
  const live = running.get(job.exportId)
  const dataSource = makeDataSource(config, {
    patientRefs: job.patientRefs ? new Set(job.patientRefs) : null,
    since: job.since,
  })
  try {
    job.status = 'in-progress'
    saveJob(config, job)
    for (const subject of subjects) {
      if (live.cancelled) return
      const result = await executeSubject({
        subject,
        graph,
        dataSource,
        parametersResource: subject.parametersResource,
        expression: subject.expression,
      })
      const file = fileNameFor(subject.name, job.format)
      const body = formatRows(result.rows, result.columns, job.format, job.header)
      if (live.cancelled) return
      fs.mkdirSync(path.join(jobDir(config, job.exportId), FILES_DIR), { recursive: true })
      fs.writeFileSync(outputPath(config, job.exportId, file), body)
      job.outputs.push({ name: subject.name, file, rows: result.rows.length })
      saveJob(config, job)
    }
    job.status = 'completed'
  } catch (err) {
    if (live.cancelled) return
    if (!err.status) console.error('Export job failed', err)
    job.status = 'failed'
    job.error = {
      status: err.status || 500,
      issues: err.issues || [issue('exception', err.message || String(err))],
    }
  } finally {
    running.delete(job.exportId)
  }
  job.endTime = new Date().toISOString()
  saveJob(config, job)
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function sendFhir(res, status, resource, headers = {}) {
  res.status(status)
  res.setHeader('Content-Type', 'application/fhir+json')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.send(JSON.stringify(resource, null, 2))
}

function identityParameters(job) {
  const parameter = [{ name: 'exportId', valueString: job.exportId }]
  if (job.clientTrackingId) parameter.push({ name: 'clientTrackingId', valueString: job.clientTrackingId })
  parameter.push({ name: 'status', valueCode: job.status })
  parameter.push({ name: 'location', valueUri: statusUrl(job.baseUrl, job.exportId) })
  return parameter
}

function kickOffResponse(job) {
  return {
    resourceType: 'Parameters',
    parameter: [
      ...identityParameters(job),
      { name: 'cancelUrl', valueUri: statusUrl(job.baseUrl, job.exportId) },
    ],
  }
}

function interimResponse(job) {
  return {
    resourceType: 'Parameters',
    parameter: [...identityParameters(job), { name: 'exportStartTime', valueInstant: job.startTime }],
  }
}

/**
 * Build the manifest for a completed job.
 *
 * @param {object} job - The job record.
 * @returns {object} the manifest Parameters resource.
 */
export function manifest(job) {
  const duration = Math.round((Date.parse(job.endTime) - Date.parse(job.startTime)) / 1000)
  return {
    resourceType: 'Parameters',
    parameter: [
      ...identityParameters(job),
      { name: '_format', valueCode: job.format },
      { name: 'exportStartTime', valueInstant: job.startTime },
      { name: 'exportEndTime', valueInstant: job.endTime },
      { name: 'exportDuration', valueInteger: duration },
      ...job.outputs.map((o) => ({
        name: 'output',
        part: [
          { name: 'name', valueString: o.name },
          { name: 'location', valueUri: `${job.baseUrl}/$sql-export/${job.exportId}/${o.file}` },
        ],
      })),
    ],
  }
}

function notFound(res, exportId) {
  sendError(res, operationError(404, [issue('not-found', `Export '${exportId}' not found`)]))
}

function findJob(req, res) {
  const job = loadJob(req.config, req.params.id)
  if (!job || job.status === 'cancelled') {
    notFound(res, req.params.id)
    return null
  }
  return job
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * `POST [base]/$sql-export`: validate synchronously, then respond 202 with the
 * status URL in `Content-Location`.
 */
export async function postSqlExport(req, res) {
  try {
    const params = requireParameters(req.body)
    const prefer = (req.headers.prefer || '').split(',').map((p) => p.trim().toLowerCase())
    if (!prefer.includes('respond-async')) {
      fail(400, 'required', "The 'Prefer: respond-async' header is required")
    }
    const job = await startExport(req.config, params, getBaseUrl(req))
    sendFhir(res, 202, kickOffResponse(job), { 'Content-Location': statusUrl(job.baseUrl, job.exportId) })
  } catch (err) {
    sendError(res, err)
  }
}

/** `GET [base]/$sql-export` is rejected: the operation creates a job. */
export function getSqlExport(req, res) {
  sendError(res, operationError(400, [issue('required', '$sql-export must be invoked with POST')]))
}

/** `GET` on the status URL: 202 while running, 303 to the result URL once finished. */
export function getStatus(req, res) {
  const job = findJob(req, res)
  if (!job) return
  if (job.status === 'completed' || job.status === 'failed') {
    res.setHeader('Location', resultUrl(job.baseUrl, job.exportId))
    res.status(303).end()
    return
  }
  sendFhir(res, 202, interimResponse(job), {
    'Retry-After': '1',
    'X-Progress': `${Math.round((job.outputs.length / job.subjects.length) * 100)}%`,
  })
}

/** `DELETE` on the status URL cancels the job and removes its files. */
export function cancelExport(req, res) {
  const job = findJob(req, res)
  if (!job) return
  const live = running.get(job.exportId)
  if (live) live.cancelled = true
  fs.rmSync(path.join(jobDir(req.config, job.exportId), FILES_DIR), { recursive: true, force: true })
  job.status = 'cancelled'
  job.outputs = []
  job.endTime = new Date().toISOString()
  saveJob(req.config, job)
  res.status(202).end()
}

/** `GET` on the result URL: the manifest, or the failure OperationOutcome. */
export function getResult(req, res) {
  const job = findJob(req, res)
  if (!job) return
  if (job.status === 'completed') {
    sendFhir(res, 200, manifest(job))
  } else if (job.status === 'failed') {
    sendFhir(res, job.error.status, outcome(job.error.issues))
  } else {
    sendFhir(res, 202, interimResponse(job), { 'Content-Location': statusUrl(job.baseUrl, job.exportId) })
  }
}

/** `GET` on an `output.location` URL streams the exported file. */
export function getOutput(req, res) {
  const job = findJob(req, res)
  if (!job) return
  const output = job.outputs.find((o) => o.file === req.params.file)
  if (job.status !== 'completed' || !output) return notFound(res, `${req.params.id}/${req.params.file}`)
  res.setHeader('Content-Type', MEDIA_TYPES[job.format])
  res.setHeader('Content-Disposition', `attachment; filename="${output.file}"`)
  res.sendFile(outputPath(req.config, job.exportId, output.file))
}

export function mountRoutes(app) {
  app.post('/\\$sql-export', postSqlExport)
  app.get('/\\$sql-export', getSqlExport)
  app.get('/\\$sql-export/:id/status', getStatus)
  app.delete('/\\$sql-export/:id/status', cancelExport)
  app.get('/\\$sql-export/:id/result', getResult)
  app.get('/\\$sql-export/:id/:file', getOutput)
}
