/**
 * Behaviour shared by the `$sql-run` and `$sql-export` operations, as specified
 * in Common Operation Behavior of the SQL on FHIR implementation guide:
 * error reporting, parameter handling, output format negotiation, subject
 * naming, the `context` matching algorithm, filtering and subject execution.
 *
 * Author: John Grimes
 */

import { read, searchAll, expandValueSet } from './db.js'
import { evaluate } from '../index.js'
import { validateSqlLibraryShape } from './sqlLibraryValidation.js'
import { inPatientCompartment } from './compartment.js'
import { runLibrary, valueFieldForFhirType } from './sqlEngine.js'

export const SPEC_BASE = 'http://hl7.org/fhir/uv/sql-on-fhir'
export const SQL_TEXT_EXTENSION = `${SPEC_BASE}/StructureDefinition/sql-text`
export const LIBRARY_TYPES_SYSTEM = `${SPEC_BASE}/CodeSystem/LibraryTypesCodes`

/** Native media type of each output format. */
export const MEDIA_TYPES = {
  csv: 'text/csv',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  parquet: 'application/vnd.apache.parquet',
  fhir: 'application/fhir+json',
}

/** Every format the specification enumerates, supported here or not. */
const KNOWN_FORMATS = Object.keys(MEDIA_TYPES)

/** Formats this server implements on `$sql-run`. */
export const RUN_FORMATS = ['csv', 'json', 'ndjson', 'fhir']

/** Formats this server implements on `$sql-export`. */
export const EXPORT_FORMATS = ['csv', 'json', 'ndjson']

/** Parameters the specification offers that this server does not support. */
export const UNSUPPORTED_PARAMETERS = ['source']

// ---------------------------------------------------------------------------
// Errors and OperationOutcome
// ---------------------------------------------------------------------------

/**
 * Build a single OperationOutcome issue.
 *
 * @param {string} code - FHIR issue type code.
 * @param {string} diagnostics - Human-readable description.
 * @param {string} [expression] - Parameter (or part) at fault.
 * @returns {object} the issue.
 */
export function issue(code, diagnostics, expression) {
  const result = { severity: 'error', code, diagnostics }
  if (expression) result.expression = [expression]
  return result
}

/**
 * Build an error carrying an HTTP status and OperationOutcome issues.
 *
 * @param {number} status - HTTP status code.
 * @param {object[]} issues - Issues built with `issue()`.
 * @returns {Error} the error, with `status` and `issues` properties.
 */
export function operationError(status, issues) {
  const err = new Error(issues.map((i) => i.diagnostics).join('; '))
  err.status = status
  err.issues = issues
  return err
}

/**
 * Throw an operation error with a single issue.
 *
 * @param {number} status - HTTP status code.
 * @param {string} code - FHIR issue type code.
 * @param {string} diagnostics - Human-readable description.
 * @param {string} [expression] - Parameter at fault.
 * @throws {Error} always.
 */
export function fail(status, code, diagnostics, expression) {
  throw operationError(status, [issue(code, diagnostics, expression)])
}

/**
 * Build an OperationOutcome resource from a list of issues.
 *
 * @param {object[]} issues - Issues built with `issue()`.
 * @returns {object} the OperationOutcome.
 */
export function outcome(issues) {
  return { resourceType: 'OperationOutcome', issue: issues }
}

/**
 * Combine the errors collected while validating independent parts of a request
 * into one error. A 404 (an artifact the operation is about is missing) is more
 * fundamental than a 400 (a scoping value is at fault), so it wins the status;
 * every issue is reported.
 *
 * @param {Error[]} errors - Errors produced by `operationError`.
 * @returns {Error|null} the combined error, or null when the list is empty.
 */
export function combineErrors(errors) {
  if (errors.length === 0) return null
  const status = errors.some((e) => e.status === 404) ? 404 : Math.max(...errors.map((e) => e.status || 500))
  return operationError(
    status,
    errors.flatMap((e) => e.issues || [issue('exception', e.message)]),
  )
}

/**
 * Send an error as an OperationOutcome response. Errors without a status are
 * unexpected and reported as 500.
 *
 * @param {object} res - Express response.
 * @param {Error} err - The error to send.
 */
export function sendError(res, err) {
  if (!err.status) {
    console.error('Unexpected operation error', err)
  }
  res.status(err.status || 500)
  res.setHeader('Content-Type', 'application/fhir+json')
  res.send(JSON.stringify(outcome(err.issues || [issue('exception', err.message || String(err))]), null, 2))
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const VALUE_FIELDS = {
  canonical: 'valueCanonical',
  Reference: 'valueReference',
  code: 'valueCode',
  string: 'valueString',
  boolean: 'valueBoolean',
  integer: 'valueInteger',
  instant: 'valueInstant',
  uri: 'valueUri',
}

/**
 * Check that a request body is a Parameters resource.
 *
 * @param {unknown} body - Parsed request body.
 * @returns {object} the Parameters resource.
 * @throws {Error} 400 when the body is not a Parameters resource.
 */
export function requireParameters(body) {
  if (!body || body.resourceType !== 'Parameters') {
    fail(400, 'invalid', 'Request body must be a Parameters resource')
  }
  if (body.parameter !== undefined && !Array.isArray(body.parameter)) {
    fail(400, 'invalid', 'Parameters.parameter must be an array')
  }
  return body
}

/**
 * Convert a query string into a Parameters resource according to a parameter
 * definition. Resource-carrying parameters cannot be expressed as query
 * parameters and are rejected.
 *
 * @param {object} query - Express `req.query`.
 * @param {object} definition - Map of parameter name to `{type, max}`.
 * @returns {object} the Parameters resource.
 * @throws {Error} 400 when a value cannot be represented as the declared type.
 * @example
 * parametersFromQuery({ _limit: '5' }, { _limit: { type: 'integer' } })
 * // => { resourceType: 'Parameters', parameter: [{ name: '_limit', valueInteger: 5 }] }
 */
export function parametersFromQuery(query, definition) {
  const parameter = []
  for (const [name, raw] of Object.entries(query)) {
    const def = definition[name]
    if (!def) {
      // Unknown names are reported by checkParameterNames with the right code.
      parameter.push({ name, valueString: String(raw) })
      continue
    }
    if (def.type === 'resource') {
      fail(
        400,
        'invalid',
        `Parameter '${name}' carries a resource and cannot be supplied over GET; use POST`,
        name,
      )
    }
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      parameter.push({ name, ...queryValue(name, String(value), def.type) })
    }
  }
  return { resourceType: 'Parameters', parameter }
}

function queryValue(name, value, type) {
  switch (type) {
    case 'Reference':
      return { valueReference: { reference: value } }
    case 'boolean':
      if (value !== 'true' && value !== 'false')
        fail(400, 'invalid', `Parameter '${name}' must be true or false`, name)
      return { valueBoolean: value === 'true' }
    case 'integer': {
      if (!/^-?\d+$/.test(value)) fail(400, 'invalid', `Parameter '${name}' must be an integer`, name)
      return { valueInteger: Number(value) }
    }
    default:
      return { [VALUE_FIELDS[type] || 'valueString']: value }
  }
}

/**
 * Reject parameters the operation does not define or this server does not
 * support, and repeats of parameters declared with max 1.
 *
 * @param {object} parameters - Parameters resource.
 * @param {object} definition - Map of parameter name to `{type, max}`.
 * @param {object} [options] - `{ invalid: string[] }` names that are defined by the specification for the other operation only and are rejected as invalid.
 * @throws {Error} 400 with `not-supported` or `invalid`.
 */
export function checkParameterNames(parameters, definition, { invalid = [] } = {}) {
  const counts = {}
  for (const p of parameters.parameter || []) {
    counts[p.name] = (counts[p.name] || 0) + 1
    if (invalid.includes(p.name)) {
      fail(400, 'invalid', `Parameter '${p.name}' is not offered on this operation`, p.name)
    }
    if (UNSUPPORTED_PARAMETERS.includes(p.name)) {
      fail(400, 'not-supported', `The server does not support the '${p.name}' parameter`, p.name)
    }
    if (!definition[p.name]) {
      fail(400, 'not-supported', `Unknown parameter '${p.name}'`, p.name)
    }
  }
  for (const [name, count] of Object.entries(counts)) {
    if (count > 1 && definition[name].max !== '*') {
      fail(400, 'invalid', `Parameter '${name}' may only be supplied once`, name)
    }
  }
}

/**
 * Return every parameter (or part) with the given name.
 *
 * @param {object} container - A Parameters resource or a parameter with parts.
 * @param {string} name - Parameter name.
 * @returns {object[]} the matching entries.
 */
export function paramsNamed(container, name) {
  const list = container?.parameter || container?.part || []
  return list.filter((p) => p.name === name)
}

/**
 * Return the value of a parameter: its `value[x]`, its `resource`, or undefined.
 *
 * @param {object} param - A Parameters.parameter entry.
 * @returns {unknown} the value.
 */
export function valueOf(param) {
  if (!param) return undefined
  if (param.resource !== undefined) return param.resource
  const key = Object.keys(param).find((k) => k.startsWith('value'))
  return key ? param[key] : undefined
}

/**
 * Return the value of the single parameter with the given name.
 *
 * @param {object} container - A Parameters resource or a parameter with parts.
 * @param {string} name - Parameter name.
 * @returns {unknown} the value, or undefined when absent.
 */
export function value(container, name) {
  return valueOf(paramsNamed(container, name)[0])
}

// ---------------------------------------------------------------------------
// Output format negotiation
// ---------------------------------------------------------------------------

const ACCEPT_TO_FORMAT = {
  'text/csv': 'csv',
  'application/json': 'json',
  'application/x-ndjson': 'ndjson',
  'application/ndjson': 'ndjson',
  'application/vnd.apache.parquet': 'parquet',
}

function acceptedMediaTypes(accept) {
  if (!accept) return []
  return accept.split(',').map((part) => part.split(';')[0].trim().toLowerCase())
}

/**
 * Select the output format (Axis 1 of content negotiation): `_format` wins,
 * else the `Accept` header may select one, else `ndjson`.
 *
 * @param {object} options - Negotiation inputs.
 * @param {string|null} options.format - The `_format` parameter, if supplied.
 * @param {string|undefined} options.accept - The `Accept` header.
 * @param {string[]} options.allowed - Formats the operation supports on this server.
 * @param {boolean} [options.useAccept=true] - Whether `Accept` may select a format (false on export).
 * @param {object} [options.invalid={}] - Map of format to issue code for formats the operation does not offer.
 * @returns {string} the chosen format.
 * @throws {Error} 400 when the requested format is not supported.
 */
export function negotiateFormat({ format, accept, allowed, useAccept = true, invalid = {} }) {
  if (format) {
    if (invalid[format]) {
      fail(400, invalid[format], `Format '${format}' is not available on this operation`, '_format')
    }
    if (!allowed.includes(format)) {
      const known = KNOWN_FORMATS.includes(format)
        ? 'is not supported by this server'
        : 'is not a recognised format'
      fail(400, 'not-supported', `Format '${format}' ${known}`, '_format')
    }
    return format
  }
  if (useAccept) {
    for (const mediaType of acceptedMediaTypes(accept)) {
      const candidate = ACCEPT_TO_FORMAT[mediaType]
      if (candidate && allowed.includes(candidate)) return candidate
    }
  }
  return 'ndjson'
}

/**
 * Select the representation (Axis 2 of content negotiation) from the `Accept`
 * header: `raw` payload, or a serialised `Binary` envelope for FHIR media types.
 *
 * @param {string|undefined} accept - The `Accept` header.
 * @returns {'raw'|'fhir+json'|'fhir+xml'} the representation.
 */
export function representationFor(accept) {
  for (const mediaType of acceptedMediaTypes(accept)) {
    if (mediaType === 'application/fhir+json') return 'fhir+json'
    if (mediaType === 'application/fhir+xml') return 'fhir+xml'
  }
  return 'raw'
}

// ---------------------------------------------------------------------------
// Artifacts and subjects
// ---------------------------------------------------------------------------

/**
 * Classify a resource as one of the three subject kinds.
 *
 * @param {object} resource - A candidate artifact.
 * @returns {'ViewDefinition'|'SQLQuery'|'SQLView'|null} the kind, or null when it is none of them.
 */
export function artifactKind(resource) {
  if (!resource || typeof resource !== 'object') return null
  if (resource.resourceType === 'ViewDefinition') return 'ViewDefinition'
  if (resource.resourceType !== 'Library') return null
  const code = (resource.type?.coding || []).find((c) => typeof c.code === 'string')?.code
  if (code === 'sql-query') return 'SQLQuery'
  if (code === 'sql-view') return 'SQLView'
  return null
}

/**
 * Split a canonical reference into its URL and optional version.
 *
 * @param {string} canonical - `url` or `url|version`.
 * @returns {{url: string, version: string|null}} the parts.
 */
export function parseCanonical(canonical) {
  const idx = canonical.indexOf('|')
  if (idx === -1) return { url: canonical, version: null }
  return { url: canonical.slice(0, idx), version: canonical.slice(idx + 1) }
}

function compareVersions(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true })
}

/**
 * Resolve a canonical URL against the server's stored ViewDefinitions and
 * Libraries. Without a version the highest version is selected.
 *
 * @param {object} config - Server config.
 * @param {string} url - Canonical URL.
 * @param {string|null} version - Version to pin, or null.
 * @returns {Promise<{kind: string, resource: object}|null>} the artifact, or null.
 */
export async function lookupCanonical(config, url, version) {
  const candidates = [
    ...(await searchAll(config, 'ViewDefinition')),
    ...(await searchAll(config, 'Library')),
  ].filter((r) => r.url === url && (version === null || r.version === version))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => compareVersions(b.version, a.version))
  const resource = candidates[0]
  return { kind: artifactKind(resource), resource }
}

/**
 * Resolve a literal reference (`Type/id`, or an absolute URL under the server
 * base) to a stored artifact.
 *
 * @param {object} config - Server config.
 * @param {string} reference - The reference string.
 * @param {string} baseUrl - The server base URL.
 * @returns {Promise<{kind: string, resource: object}|null>} the artifact, or null.
 */
export async function lookupReference(config, reference, baseUrl) {
  let relative = reference
  if (baseUrl && reference.startsWith(baseUrl + '/')) relative = reference.slice(baseUrl.length + 1)
  const match = /^(ViewDefinition|Library)\/([^/]+)$/.exec(relative)
  if (!match) return null
  const resource = await read(config, match[1], match[2])
  return resource ? { kind: artifactKind(resource), resource } : null
}

/**
 * Resolve the subject named by exactly one of `subjectCanonical`,
 * `subjectReference` and `subjectResource`.
 *
 * @param {object} config - Server config.
 * @param {object} naming - `{subjectCanonical, subjectReference, subjectResource}` values, absent ones undefined.
 * @param {object} options - `{ baseUrl, prefix }`; `prefix` is prepended to expressions (e.g. `subject[1].`).
 * @returns {Promise<{kind: string, resource: object, form: string}>} the resolved subject and the naming form used.
 * @throws {Error} 400 (none or several forms), 404 (unresolvable), 422 (not a ViewDefinition, SQLQuery or SQLView).
 */
export async function resolveSubject(config, naming, { baseUrl, prefix = '' }) {
  const forms = ['subjectCanonical', 'subjectReference', 'subjectResource'].filter(
    (f) => naming[f] !== undefined && naming[f] !== null,
  )
  if (forms.length === 0) {
    fail(
      400,
      'required',
      'One of subjectCanonical, subjectReference or subjectResource must be supplied',
      `${prefix}subject`,
    )
  }
  if (forms.length > 1) {
    fail(
      400,
      'invalid',
      `Only one of subjectCanonical, subjectReference and subjectResource may be supplied; got ${forms.join(', ')}`,
      `${prefix}subject`,
    )
  }
  const form = forms[0]
  const expression = `${prefix}${form}`
  let resolved
  if (form === 'subjectCanonical') {
    const canonical = naming.subjectCanonical
    if (typeof canonical !== 'string')
      fail(400, 'invalid', 'subjectCanonical must be a canonical string', expression)
    const { url, version } = parseCanonical(canonical)
    resolved = await lookupCanonical(config, url, version)
    if (!resolved) fail(404, 'not-found', `Subject with canonical '${canonical}' not found`, expression)
  } else if (form === 'subjectReference') {
    const reference = naming.subjectReference?.reference
    if (typeof reference !== 'string')
      fail(400, 'invalid', 'subjectReference must be a Reference with a reference string', expression)
    resolved = await lookupReference(config, reference, baseUrl)
    if (!resolved) fail(404, 'not-found', `Subject with reference '${reference}' not found`, expression)
  } else {
    resolved = { kind: artifactKind(naming.subjectResource), resource: naming.subjectResource }
  }
  if (!resolved.kind) {
    fail(422, 'invalid', 'Subject is not a ViewDefinition, SQLQuery Library or SQLView Library', expression)
  }
  if (resolved.kind !== 'ViewDefinition') {
    const errors = validateSqlLibraryShape(resolved.resource).filter((i) => i.severity === 'error')
    if (errors.length > 0) {
      throw operationError(
        422,
        errors.map((e) => issue('invalid', e.diagnostics, expression)),
      )
    }
  }
  return { ...resolved, form }
}

// ---------------------------------------------------------------------------
// Supporting artifacts (context)
// ---------------------------------------------------------------------------

function dependenciesOf(artifact) {
  if (artifact.kind === 'ViewDefinition') return []
  return (artifact.resource.relatedArtifact || [])
    .filter((a) => a.type === 'depends-on' && typeof a.resource === 'string')
    .map((a) => ({ ...parseCanonical(a.resource), label: a.label }))
}

/**
 * Resolve the transitive dependency graph of every subject, matching supplied
 * `context` entries by canonical URL, as specified in "Matching supplied
 * artifacts to dependencies".
 *
 * @param {object} options - Inputs.
 * @param {object[]} options.subjects - Resolved subjects, or bare resources (classified with `artifactKind`).
 * @param {object[]} options.context - Inline ViewDefinition and SQLView resources.
 * @param {(url: string, version: string|null) => Promise<{kind: string, resource: object}|null>} options.lookup - Server-side canonical resolver.
 * @returns {Promise<Map<string, {kind: string, resource: object}>>} canonical URL to resolved artifact.
 * @throws {Error} 400 for an unusable or unmatched context entry, 404 for an unresolvable dependency.
 */
export async function resolveGraph({ subjects, context, lookup }) {
  const contextByUrl = new Map()
  for (const entry of context) {
    const kind = artifactKind(entry)
    if (!entry?.url) {
      fail(400, 'invalid', 'A context entry has no url and cannot be bound to any dependency', 'context')
    }
    if (kind !== 'ViewDefinition' && kind !== 'SQLView') {
      fail(400, 'invalid', `Context entry '${entry.url}' is not a ViewDefinition or SQLView`, 'context')
    }
    if (contextByUrl.has(entry.url)) {
      fail(400, 'invalid', `Two context entries share the url '${entry.url}'`, 'context')
    }
    contextByUrl.set(entry.url, { kind, resource: entry })
  }

  const resolved = new Map()
  const used = new Set()
  const worklist = subjects.flatMap((s) =>
    dependenciesOf(s.kind ? s : { kind: artifactKind(s), resource: s }),
  )
  while (worklist.length > 0) {
    const dep = worklist.shift()
    if (resolved.has(dep.url)) continue
    let artifact = null
    const supplied = contextByUrl.get(dep.url)
    if (supplied && (dep.version === null || supplied.resource.version === dep.version)) {
      artifact = supplied
      used.add(dep.url)
    } else {
      artifact = await lookup(dep.url, dep.version)
    }
    if (!artifact) {
      const pinned = dep.version ? `${dep.url}|${dep.version}` : dep.url
      fail(
        404,
        'not-found',
        `Dependency '${pinned}' was neither supplied as a context entry nor resolvable by the server`,
      )
    }
    if (artifact.kind !== 'ViewDefinition' && artifact.kind !== 'SQLView') {
      fail(
        422,
        'invalid',
        `Dependency '${dep.url}' resolved to a ${artifact.kind || 'resource'} rather than a ViewDefinition or SQLView`,
      )
    }
    resolved.set(dep.url, artifact)
    if (artifact.kind === 'SQLView') worklist.push(...dependenciesOf(artifact))
  }

  for (const url of contextByUrl.keys()) {
    if (!used.has(url)) {
      fail(
        400,
        'invalid',
        `Supplied context entry '${url}' does not match any relatedArtifact dependency of the subject`,
        'context',
      )
    }
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function relativeReference(reference) {
  const parts = String(reference).split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : reference
}

/**
 * Resolve the `patient` and `group` filters to a set of `Patient/<id>` strings.
 *
 * @param {object} config - Server config.
 * @param {object} filters - `{ patients: Reference[], groups: Reference[] }`.
 * @param {object[]} [inline] - Inline resources that may also satisfy a patient reference.
 * @returns {Promise<Set<string>|null>} the compartment patients, or null when no filter was supplied.
 * @throws {Error} 400 not-found naming `patient` or `group`, reporting every unresolvable value.
 */
export async function resolvePatientFilter(config, { patients = [], groups = [] }, inline = []) {
  if (patients.length === 0 && groups.length === 0) return null
  const issues = []
  const refs = new Set()
  for (const ref of patients) {
    const relative = relativeReference(ref?.reference)
    const match = /^Patient\/([^/]+)$/.exec(relative || '')
    const found =
      match &&
      ((await read(config, 'Patient', match[1])) ||
        inline.some((r) => r.resourceType === 'Patient' && r.id === match[1]))
    if (!found) {
      issues.push(issue('not-found', `Patient with reference '${ref?.reference}' not found`, 'patient'))
      continue
    }
    refs.add(relative)
  }
  for (const ref of groups) {
    const relative = relativeReference(ref?.reference)
    const match = /^Group\/([^/]+)$/.exec(relative || '')
    const group = match && (await read(config, 'Group', match[1]))
    if (!group) {
      issues.push(issue('not-found', `Group with reference '${ref?.reference}' not found`, 'group'))
      continue
    }
    for (const member of group.member || []) {
      const entity = relativeReference(member.entity?.reference)
      if (entity?.startsWith('Patient/')) refs.add(entity)
    }
  }
  if (issues.length > 0) throw operationError(400, issues)
  return refs
}

/**
 * Keep resources whose `meta.lastUpdated` is after the instant, plus resources
 * that carry no `lastUpdated` at all.
 *
 * @param {object[]} resources - FHIR resources.
 * @param {string|null} since - The `_since` instant, or null for no filter.
 * @returns {object[]} the filtered resources (the same array when `since` is null).
 */
export function applySince(resources, since) {
  if (!since) return resources
  const threshold = Date.parse(since)
  if (Number.isNaN(threshold)) fail(400, 'invalid', `'_since' must be an instant; got '${since}'`, '_since')
  return resources.filter((r) => {
    const updated = r.meta?.lastUpdated
    return !updated || Date.parse(updated) > threshold
  })
}

/**
 * Unwrap the `resource` parameter values: a Bundle contributes each
 * `entry.resource`, anything else contributes itself.
 *
 * @param {object[]} resources - Values of the repeating `resource` parameter.
 * @returns {object[]} the discrete resources.
 */
export function unwrapResources(resources) {
  return resources.flatMap((r) =>
    r?.resourceType === 'Bundle' ? (r.entry || []).map((e) => e.resource).filter(Boolean) : [r],
  )
}

/**
 * Build the function that supplies the FHIR resources feeding a view, with the
 * job's filters applied before projection.
 *
 * @param {object} config - Server config.
 * @param {object} filters - `{ patientRefs: Set<string>|null, since: string|null }`.
 * @param {object[]|null} inline - Inline resources to use instead of server data, or null.
 * @returns {(resourceType: string) => Promise<object[]>} the data source.
 */
export function makeDataSource(config, { patientRefs = null, since = null }, inline = null) {
  return async (resourceType) => {
    let resources = inline
      ? inline.filter((r) => r?.resourceType === resourceType)
      : await searchAll(config, resourceType)
    resources = applySince(resources, since)
    if (patientRefs) resources = resources.filter((r) => inPatientCompartment(r, patientRefs))
    return resources
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Declared columns of a ViewDefinition, in order.
 *
 * @param {object} viewDefinition - The ViewDefinition.
 * @returns {{name: string, type: string|undefined}[]} the columns.
 */
export function viewColumns(viewDefinition) {
  const columns = []
  const walk = (node) => {
    if (!node) return
    for (const c of node.column || []) columns.push({ name: c.name, type: c.type })
    for (const s of node.select || []) walk(s)
    for (const u of node.unionAll || []) walk(u)
  }
  for (const s of viewDefinition.select || []) walk(s)
  return columns
}

function evaluateView(viewDefinition, resources, expression) {
  try {
    return evaluate(viewDefinition, resources, false)
  } catch (err) {
    throw operationError(422, [
      issue('invalid', `ViewDefinition could not be evaluated: ${err.message}`, expression),
    ])
  }
}

/**
 * Execute a resolved subject and return its rows together with the FHIR
 * `value[x]` field to use for each column in the `fhir` format.
 *
 * @param {object} options - Inputs.
 * @param {{kind: string, resource: object}} options.subject - The resolved subject.
 * @param {Map<string, object>} options.graph - Dependency graph from `resolveGraph`.
 * @param {(resourceType: string) => Promise<object[]>} options.dataSource - Filtered resource supplier.
 * @param {object|null} [options.parametersResource] - Bound parameter values for a SQL subject.
 * @param {string} [options.expression='subject'] - Expression used in issues raised by execution.
 * @returns {Promise<{rows: object[], columns: string[], valueFields: object}>} rows, column order and per-column value fields.
 * @throws {Error} 400 for bad parameter bindings, 422 for a subject that cannot be processed.
 */
export async function executeSubject({
  subject,
  graph,
  dataSource,
  parametersResource = null,
  expression = 'subject',
}) {
  if (subject.kind === 'ViewDefinition') {
    const view = subject.resource
    const rows = evaluateView(view, await dataSource(view.resource), expression)
    const columns = viewColumns(view)
    const valueFields = {}
    for (const c of columns) valueFields[c.name] = valueFieldForFhirType(c.type)
    return { rows, columns: columns.map((c) => c.name), valueFields }
  }
  return runLibrary({
    library: subject.resource,
    parametersResource,
    resolveDependency: (url) => graph.get(url) || null,
    evaluateView: async (view) => evaluateView(view, await dataSource(view.resource), expression),
    expression,
  })
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Serialise rows in one of the flat formats.
 *
 * @param {object[]} rows - Result rows.
 * @param {string[]} columns - Column order (used for the CSV header when there are no rows).
 * @param {'csv'|'json'|'ndjson'} format - Output format.
 * @param {boolean} [header=true] - Whether CSV output starts with a header row.
 * @returns {string} the serialised body.
 */
export function formatRows(rows, columns, format, header = true) {
  if (format === 'json') return JSON.stringify(rows)
  if (format === 'ndjson') return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  if (format === 'csv') {
    const cols = columns.length > 0 ? columns : rows.length > 0 ? Object.keys(rows[0]) : []
    const lines = header ? [cols.join(',')] : []
    for (const row of rows) lines.push(cols.map((c) => csvEscape(row[c])).join(','))
    return lines.join('\n') + (lines.length ? '\n' : '')
  }
  throw operationError(500, [issue('exception', `No serialiser for format '${format}'`)])
}

function inferValueField(column, rows) {
  for (const row of rows) {
    const v = row[column]
    if (v === null || v === undefined) continue
    if (typeof v === 'boolean') return 'valueBoolean'
    if (typeof v === 'number') return Number.isInteger(v) ? 'valueInteger' : 'valueDecimal'
    if (typeof v === 'string') return 'valueString'
    fail(422, 'invalid', `Result column '${column}' has a type with no FHIR value[x] mapping`)
  }
  return null
}

/**
 * Serialise rows as the `fhir` format: a Parameters resource with one `row`
 * parameter per result row, SQL NULL represented by omitting the part.
 *
 * @param {object[]} rows - Result rows.
 * @param {object} valueFields - Column name to `value[x]` field; columns missing here are inferred from the data.
 * @returns {object} the Parameters resource.
 * @throws {Error} 422 when a column has no FHIR mapping.
 */
export function formatFhir(rows, valueFields) {
  if (rows.length === 0) return { resourceType: 'Parameters' }
  const fields = { ...valueFields }
  for (const column of Object.keys(rows[0])) {
    if (!fields[column]) fields[column] = inferValueField(column, rows)
  }
  return {
    resourceType: 'Parameters',
    parameter: rows.map((row) => ({
      name: 'row',
      part: Object.entries(row)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([column, v]) => {
          const field = fields[column]
          let coerced = v
          if (field === 'valueBoolean') coerced = Boolean(v)
          else if (field === 'valueInteger64' || field === 'valueDecimal')
            coerced = typeof v === 'string' ? Number(v) : v
          else if (typeof v === 'object') coerced = JSON.stringify(v)
          return { name: column, [field]: coerced }
        }),
    })),
  }
}

/**
 * Expand the code system bound to a format parameter for display in forms.
 *
 * @param {object} config - Server config.
 * @param {string} valueSetUrl - Canonical URL of the value set.
 * @returns {Promise<{code: string, display: string}[]>} the concepts, or an empty list.
 */
export async function formatConcepts(config, valueSetUrl) {
  const valueSet = await expandValueSet(config, valueSetUrl)
  return valueSet?.concept || []
}
