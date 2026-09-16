/**
 * The `$sql-run` operation: synchronous evaluation of a ViewDefinition,
 * SQLQuery Library or SQLView Library, returning the result in the requested
 * output format.
 *
 * Author: John Grimes
 */

import { getBaseUrl } from './utils.js'
import {
  RUN_FORMATS,
  MEDIA_TYPES,
  requireParameters,
  parametersFromQuery,
  checkParameterNames,
  paramsNamed,
  value,
  valueOf,
  negotiateFormat,
  representationFor,
  resolveSubject,
  resolveGraph,
  lookupCanonical,
  resolvePatientFilter,
  unwrapResources,
  makeDataSource,
  executeSubject,
  formatRows,
  formatFhir,
  combineErrors,
  fail,
  sendError,
} from './operations.js'

/** Input parameters of `$sql-run` as supported by this server. */
export const RUN_PARAMETERS = {
  subjectCanonical: { type: 'canonical', max: '1' },
  subjectReference: { type: 'Reference', max: '1' },
  subjectResource: { type: 'resource', max: '1' },
  parameters: { type: 'resource', max: '1' },
  context: { type: 'resource', max: '*' },
  resource: { type: 'resource', max: '*' },
  _format: { type: 'code', max: '1' },
  header: { type: 'boolean', max: '1' },
  patient: { type: 'Reference', max: '*' },
  group: { type: 'Reference', max: '*' },
  _since: { type: 'instant', max: '1' },
  _limit: { type: 'integer', max: '1' },
}

/**
 * Execute a `$sql-run` request expressed as a Parameters resource and return
 * the response body and media type.
 *
 * @param {object} config - Server config.
 * @param {object} params - The Parameters resource.
 * @param {object} options - `{ baseUrl, accept }`.
 * @returns {Promise<{format: string, contentType: string, body: string}>} the result.
 * @throws {Error} with `status` and `issues` for every rejection the specification defines.
 */
export async function runOperation(config, params, { baseUrl, accept }) {
  checkParameterNames(params, RUN_PARAMETERS, { invalid: ['clientTrackingId'] })

  const format = negotiateFormat({ format: value(params, '_format'), accept, allowed: RUN_FORMATS })
  const representation = representationFor(accept)
  if (format !== 'fhir' && representation === 'fhir+xml') {
    fail(406, 'not-supported', 'This server does not offer the XML envelope representation')
  }

  const inlineResources = unwrapResources(paramsNamed(params, 'resource').map(valueOf))
  const errors = []
  let subject = null
  let patientRefs = null
  try {
    subject = await resolveSubject(
      config,
      {
        subjectCanonical: value(params, 'subjectCanonical'),
        subjectReference: value(params, 'subjectReference'),
        subjectResource: value(params, 'subjectResource'),
      },
      { baseUrl },
    )
  } catch (err) {
    errors.push(err)
  }
  try {
    patientRefs = await resolvePatientFilter(
      config,
      {
        patients: paramsNamed(params, 'patient').map(valueOf),
        groups: paramsNamed(params, 'group').map(valueOf),
      },
      inlineResources,
    )
  } catch (err) {
    errors.push(err)
  }
  const combined = combineErrors(errors)
  if (combined) throw combined

  const parametersResource = value(params, 'parameters')
  const isView = subject.kind === 'ViewDefinition'
  if (parametersResource !== undefined && isView) {
    fail(
      400,
      'invalid',
      "'parameters' cannot be supplied where the subject is a ViewDefinition",
      'parameters',
    )
  }
  if (paramsNamed(params, 'resource').length > 0 && !isView) {
    fail(400, 'invalid', "'resource' can only be supplied where the subject is a ViewDefinition", 'resource')
  }

  const graph = await resolveGraph({
    subjects: [subject],
    context: paramsNamed(params, 'context').map(valueOf),
    lookup: (url, version) => lookupCanonical(config, url, version),
  })

  const dataSource = makeDataSource(
    config,
    { patientRefs, since: value(params, '_since') || null },
    paramsNamed(params, 'resource').length > 0 ? inlineResources : null,
  )
  const result = await executeSubject({
    subject,
    graph,
    dataSource,
    parametersResource: parametersResource || null,
  })

  const limit = value(params, '_limit')
  const rows = limit !== undefined ? result.rows.slice(0, Math.max(0, limit)) : result.rows

  if (format === 'fhir') {
    return {
      format,
      contentType: MEDIA_TYPES.fhir,
      body: JSON.stringify(formatFhir(rows, result.valueFields), null, 2),
    }
  }
  const header = value(params, 'header') !== false
  const payload = formatRows(rows, result.columns, format, header)
  if (representation === 'fhir+json') {
    const binary = {
      resourceType: 'Binary',
      contentType: MEDIA_TYPES[format],
      data: Buffer.from(payload).toString('base64'),
    }
    return { format, contentType: MEDIA_TYPES.fhir, body: JSON.stringify(binary) }
  }
  return { format, contentType: MEDIA_TYPES[format], body: payload }
}

async function handle(req, res, params) {
  try {
    const result = await runOperation(req.config, params, {
      baseUrl: getBaseUrl(req),
      accept: req.headers.accept,
    })
    res.status(200)
    res.setHeader('Content-Type', result.contentType)
    res.send(result.body)
  } catch (err) {
    sendError(res, err)
  }
}

/**
 * `GET [base]/$sql-run`: every parameter is primitive and comes from the query string.
 */
export async function getSqlRun(req, res) {
  let params
  try {
    params = parametersFromQuery(req.query, RUN_PARAMETERS)
  } catch (err) {
    return sendError(res, err)
  }
  await handle(req, res, params)
}

/**
 * `POST [base]/$sql-run`: the parameters arrive as a Parameters resource.
 */
export async function postSqlRun(req, res) {
  let params
  try {
    params = requireParameters(req.body)
  } catch (err) {
    return sendError(res, err)
  }
  await handle(req, res, params)
}

export function mountRoutes(app) {
  app.get('/\\$sql-run', getSqlRun)
  app.post('/\\$sql-run', postSqlRun)
}
