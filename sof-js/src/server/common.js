/**
 * Leaf helpers shared by the operation modules: OperationOutcome errors,
 * specification canonicals and ViewDefinition column metadata.
 *
 * Author: John Grimes
 */

import { get_columns } from '../index.js'

export const SPEC_BASE = 'http://hl7.org/fhir/uv/sql-on-fhir'
export const SQL_TEXT_EXTENSION = `${SPEC_BASE}/StructureDefinition/sql-text`
export const LIBRARY_TYPES_SYSTEM = `${SPEC_BASE}/CodeSystem/LibraryTypesCodes`

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

/**
 * Declared columns of a ViewDefinition, in output order. The order comes from
 * the engine's own column collection, which takes one column set per
 * `unionAll`; the type is the first declaration of each name.
 *
 * @param {object} viewDefinition - The ViewDefinition.
 * @returns {{name: string, type: string|undefined}[]} the columns.
 */
export function viewColumns(viewDefinition) {
  const types = {}
  const walk = (node) => {
    if (!node) return
    for (const c of node.column || []) if (!(c.name in types)) types[c.name] = c.type
    for (const s of node.select || []) walk(s)
    for (const u of node.unionAll || []) walk(u)
  }
  for (const s of viewDefinition.select || []) walk(s)
  let names
  try {
    names = get_columns(viewDefinition)
  } catch {
    // An inconsistent union is reported when the view is evaluated.
    names = Object.keys(types)
  }
  return names.map((name) => ({ name, type: types[name] }))
}
