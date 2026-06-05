/**
 * Validation of Library resources against the SQLQuery and SQLView profiles.
 *
 * Provides two exported functions:
 *
 * - `validateSqlLibraryShape(library)` - pure synchronous checks against the
 *   Library resource alone; no I/O.
 * - `validateSqlLibrary(library, config)` - composes the shape checks with
 *   advisory dependency-target resolution via `config`; returns a Promise.
 *
 * Both functions return an array of Issue objects:
 *   `{ severity: 'error'|'warning', code: string, diagnostics: string, expression?: string }`
 *
 * Author: John Grimes
 */

import { search } from './db.js'

// ---------------------------------------------------------------------------
// Issue helpers
// ---------------------------------------------------------------------------

/**
 * Build an error-severity issue.
 *
 * @param {string} code - FHIR issue code (e.g. 'invalid', 'required').
 * @param {string} diagnostics - Human-readable description.
 * @param {string|undefined} expression - FHIRPath expression identifying the offending element.
 * @returns {{ severity: string, code: string, diagnostics: string, expression?: string }} issue object.
 */
function errorIssue(code, diagnostics, expression) {
  const issue = { severity: 'error', code, diagnostics }
  if (expression) issue.expression = expression
  return issue
}

/**
 * Build a warning-severity issue.
 *
 * @param {string} code - FHIR issue code.
 * @param {string} diagnostics - Human-readable description.
 * @param {string|undefined} expression - FHIRPath expression identifying the offending element.
 * @returns {{ severity: string, code: string, diagnostics: string, expression?: string }} issue object.
 */
function warningIssue(code, diagnostics, expression) {
  const issue = { severity: 'warning', code, diagnostics }
  if (expression) issue.expression = expression
  return issue
}

// ---------------------------------------------------------------------------
// Type-code extraction
// ---------------------------------------------------------------------------

/**
 * Extract the type code from a Library's `type.coding` array.
 * Returns the first code found, or `null` when absent.
 *
 * @param {object} library - FHIR Library resource.
 * @returns {string|null} the type code or null.
 */
function extractTypeCode(library) {
  const codings = library?.type?.coding
  if (!Array.isArray(codings) || codings.length === 0) return null
  const first = codings.find((c) => typeof c.code === 'string')
  return first ? first.code : null
}

// ---------------------------------------------------------------------------
// SQL identifier validation
// ---------------------------------------------------------------------------

// A valid SQL identifier starts with a letter or underscore, followed by
// letters, digits, or underscores.
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Return true when the string is a valid unquoted SQL identifier.
 *
 * @param {string} label - The label string to test.
 * @returns {boolean} whether the label is a valid SQL identifier.
 */
function isValidSqlIdentifier(label) {
  return typeof label === 'string' && SQL_IDENTIFIER_RE.test(label)
}

// ---------------------------------------------------------------------------
// Pure shape validation
// ---------------------------------------------------------------------------

/**
 * Validate a Library resource against the SQLQuery/SQLView profile shape rules.
 * Performs only local checks - no I/O.
 *
 * Rules checked:
 * - `type.coding[].code` must be `sql-query` or `sql-view`.
 * - When type is `sql-view`, the `parameter` array must be absent or empty.
 * - Every `content[].contentType` must start with `application/sql`.
 * - Every `content[]` entry must supply SQL via `data` or a `sql-text`
 *   extension.
 * - Every `relatedArtifact[type=depends-on].label` must be a valid SQL
 *   identifier.
 *
 * @param {object} library - FHIR Library resource to validate.
 * @returns {Array<{severity: string, code: string, diagnostics: string, expression?: string}>} array of issues.
 */
export function validateSqlLibraryShape(library) {
  const issues = []

  // Validate the type code.
  const typeCode = extractTypeCode(library)
  if (typeCode !== 'sql-query' && typeCode !== 'sql-view') {
    issues.push(
      errorIssue(
        'invalid',
        `Library.type must have a coding with code 'sql-query' or 'sql-view'; got '${typeCode ?? '(none)'}'.`,
        'Library.type',
      ),
    )
  }

  // Validate that sql-view Libraries declare no parameters.
  if (typeCode === 'sql-view' && Array.isArray(library.parameter) && library.parameter.length > 0) {
    issues.push(
      errorIssue(
        'invalid',
        `Library of type 'sql-view' must not declare any parameters, but found ${library.parameter.length}.`,
        'Library.parameter',
      ),
    )
  }

  // Validate each content entry.
  const contents = Array.isArray(library.content) ? library.content : []
  contents.forEach((entry, idx) => {
    const expr = `Library.content[${idx}]`

    // Content type must start with application/sql.
    if (typeof entry.contentType !== 'string' || !entry.contentType.startsWith('application/sql')) {
      issues.push(
        errorIssue(
          'invalid',
          `Library.content[${idx}].contentType must start with 'application/sql'; got '${entry.contentType ?? '(none)'}'.`,
          `${expr}.contentType`,
        ),
      )
    }

    // SQL must be present via either base64 data or a sql-text extension.
    const hasSqlText = (entry.extension || []).some(
      (e) =>
        e.url === 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text' &&
        typeof e.valueString === 'string',
    )
    const hasData = typeof entry.data === 'string'
    if (!hasSqlText && !hasData) {
      issues.push(
        errorIssue(
          'required',
          `Library.content[${idx}] must contain SQL via 'data' (base64) or a 'sql-text' extension.`,
          expr,
        ),
      )
    }
  })

  // Validate relatedArtifact depends-on labels.
  const deps = (library.relatedArtifact || []).filter((a) => a.type === 'depends-on')
  deps.forEach((dep, idx) => {
    const label = dep.label
    if (!isValidSqlIdentifier(label)) {
      issues.push(
        errorIssue(
          'invalid',
          `relatedArtifact[${idx}].label '${label}' is not a valid SQL identifier (must match [A-Za-z_][A-Za-z0-9_]*).`,
          `Library.relatedArtifact[${idx}].label`,
        ),
      )
    }
  })

  return issues
}

// ---------------------------------------------------------------------------
// Dependency-target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a `relatedArtifact.resource` canonical to a ViewDefinition (first)
 * or a Library (second). Returns `null` when neither is found.
 *
 * Uses `config.search` when present (for unit-test stubs that inject their
 * own search function) and falls back to the imported db `search` otherwise.
 *
 * @param {object} config - Server config.  May supply a `search` override.
 * @param {string} ref - The canonical URL or reference string to resolve.
 * @returns {Promise<{kind: 'ViewDefinition'|'Library', resource: object}|null>} resolved resource or null.
 */
async function resolveDependencyTarget(config, ref) {
  // Allow the config to override the search function, which is useful for
  // unit tests that inject an in-memory stub without a real SQLite database.
  const searchFn = typeof config.search === 'function' ? config.search : search

  const viewDefs = await searchFn(config, 'ViewDefinition', 1000)
  const segment = (ref || '').split('/').pop()
  const vd = viewDefs.find((v) => v.url === ref || v.id === segment)
  if (vd) return { kind: 'ViewDefinition', resource: vd }

  const libs = await searchFn(config, 'Library', 1000)
  const lib = libs.find((l) => l.url === ref || l.id === segment)
  if (lib) return { kind: 'Library', resource: lib }

  return null
}

// ---------------------------------------------------------------------------
// Full validation (shape + advisory resolution)
// ---------------------------------------------------------------------------

/**
 * Validate a Library resource against the SQLQuery/SQLView profile rules,
 * including advisory dependency-target resolution.
 *
 * Composes `validateSqlLibraryShape` (pure) with resolution of each
 * `relatedArtifact[depends-on].resource` via `config`. Unresolvable targets
 * produce warnings rather than errors so that existing queries referencing
 * absent resources are not hard-rejected.
 *
 * @param {object} library - FHIR Library resource to validate.
 * @param {object} config - Server config providing `search(config, type, limit)`.
 * @returns {Promise<Array<{severity: string, code: string, diagnostics: string, expression?: string}>>} array of issues.
 */
export async function validateSqlLibrary(library, config) {
  const issues = validateSqlLibraryShape(library)

  const deps = (library.relatedArtifact || []).filter((a) => a.type === 'depends-on')
  for (let idx = 0; idx < deps.length; idx++) {
    const dep = deps[idx]
    const ref = dep.resource
    if (!ref) continue

    const resolved = await resolveDependencyTarget(config, ref)
    const expr = `Library.relatedArtifact[${idx}]`

    if (!resolved) {
      // An unresolvable canonical is advisory - warn rather than error so
      // existing queries with missing dependencies are not rejected.
      issues.push(
        warningIssue(
          'not-found',
          `Dependency '${ref}' could not be resolved to a ViewDefinition or Library.`,
          expr,
        ),
      )
      continue
    }

    if (resolved.kind === 'Library') {
      const depLib = resolved.resource
      const depTypeCode = extractTypeCode(depLib)
      if (depTypeCode !== 'sql-view') {
        issues.push(
          errorIssue(
            'invalid',
            `Dependency '${ref}' resolved to a Library of type '${depTypeCode}'; only 'sql-view' is permitted as a dependency.`,
            expr,
          ),
        )
        continue
      }
      if (Array.isArray(depLib.parameter) && depLib.parameter.length > 0) {
        issues.push(
          errorIssue(
            'invalid',
            `Dependency '${ref}' is an SQLView that declares parameters; parameterised SQLViews cannot be used as dependencies.`,
            expr,
          ),
        )
      }
    }
  }

  return issues
}
