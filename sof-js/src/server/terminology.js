/**
 * ValueSet dependencies of SQLQuery and SQLView Libraries.
 *
 * A `relatedArtifact[depends-on]` whose canonical URL names a ValueSet is
 * exposed to the SQL as a relation with the columns `system`, `version`,
 * `code`, `display` and `inactive`, one row per member of the value set. This
 * module resolves a canonical URL to that membership: from a ValueSet stored on
 * this server where one matches, otherwise from the configured FHIR
 * terminology server via `ValueSet/$expand`.
 *
 * See the "Terminology in SQL" page of the SQL on FHIR specification.
 *
 * Author: John Grimes
 */

import { searchAll } from './db.js'
import { fail, operationError, issue, parseCanonical } from './common.js'

/** Default terminology server, used when `TERMINOLOGY_SERVER_URL` is unset. */
export const DEFAULT_TERMINOLOGY_SERVER_URL = 'https://tx.fhir.org/r4'

/** Default cap on members per value set, used when `TERMINOLOGY_MAX_MEMBERS` is unset. */
export const DEFAULT_TERMINOLOGY_MAX_MEMBERS = 100000

// Members requested per `$expand` page.
const PAGE_SIZE = 1000

// Time allowed for one terminology server request.
const REQUEST_TIMEOUT_MS = 30000

/**
 * Columns of the relation a ValueSet dependency is exposed as, in order, with
 * the FHIR type each carries. `uri`, `string`, `code` and `boolean` follow the
 * specification's default type mappings.
 */
export const VALUE_SET_COLUMNS = [
  { name: 'system', type: 'uri' },
  { name: 'version', type: 'string' },
  { name: 'code', type: 'code' },
  { name: 'display', type: 'string' },
  { name: 'inactive', type: 'boolean' },
]

// Visit every `contains` entry of an expansion at any depth.
function* walkContains(entries) {
  for (const entry of entries || []) {
    yield entry
    if (Array.isArray(entry.contains)) yield* walkContains(entry.contains)
  }
}

/**
 * Flatten a `ValueSet.expansion` into relation rows: one row per distinct
 * (`system`, `version`, `code`) among the entries at any depth whose `abstract`
 * is not true. An entry lacking `system` or `code` cannot satisfy the
 * relation's non-null columns and contributes no row.
 *
 * @param {object} expansion - A `ValueSet.expansion` element.
 * @returns {Array<{system: string, version: string|null, code: string, display: string|null, inactive: boolean|null}>}
 *   the relation rows, in first-seen order.
 */
export function expansionRows(expansion) {
  const rows = new Map()
  for (const entry of walkContains(expansion?.contains)) {
    if (entry.abstract === true) continue
    if (typeof entry.system !== 'string' || typeof entry.code !== 'string') continue
    const version = typeof entry.version === 'string' ? entry.version : null
    const key = `${entry.system}\u0000${version ?? ''}\u0000${entry.code}`
    if (rows.has(key)) continue
    rows.set(key, {
      system: entry.system,
      version,
      code: entry.code,
      display: typeof entry.display === 'string' ? entry.display : null,
      inactive: typeof entry.inactive === 'boolean' ? entry.inactive : null,
    })
  }
  return [...rows.values()]
}

// Count the `contains` entries of an expansion at all depths.
function countEntries(expansion) {
  let n = 0
  for (const _ of walkContains(expansion?.contains)) n++
  return n
}

/**
 * Reject a stored expansion that does not determine membership: one carrying
 * an `offset`, or whose `total` exceeds the number of entries at all depths.
 *
 * @param {object} expansion - A `ValueSet.expansion` element.
 * @param {string} canonical - The dependency's canonical URL, for the diagnostic.
 * @throws {Error} 422 when the expansion is incomplete.
 */
export function assertCompleteExpansion(expansion, canonical) {
  // Servers echo `offset: 0` on an unpaged expansion; only a non-zero offset
  // marks a page.
  if (typeof expansion.offset === 'number' && expansion.offset > 0) {
    throw membershipError(canonical, `its expansion is a page (offset ${expansion.offset})`)
  }
  if (typeof expansion.total === 'number') {
    const entries = countEntries(expansion)
    if (expansion.total > entries) {
      throw membershipError(canonical, `its expansion lists ${entries} of ${expansion.total} entries`)
    }
  }
}

function membershipError(canonical, reason) {
  return operationError(422, [
    issue('processing', `The membership of value set '${canonical}' cannot be determined: ${reason}.`),
  ])
}

/**
 * Find the stored ValueSet matching a canonical URL. A pinned dependency
 * matches on url and version; an unpinned one on url alone, and fails when
 * more than one version is stored, since the runner then cannot decide.
 *
 * @param {object} config - Server config, optionally with a `search` override.
 * @param {string} canonical - Canonical URL, optionally `|version`.
 * @returns {Promise<object|null>} the ValueSet, or null when none matches.
 * @throws {Error} 404 when an unpinned url matches several stored versions.
 */
export async function findStoredValueSet(config, canonical) {
  const parsed = parseCanonical(canonical)
  const searchFn = typeof config.search === 'function' ? config.search : searchAll
  const all = await searchFn(config, 'ValueSet')
  const matches = all.filter(
    (vs) => vs.url === parsed.url && (parsed.version === null || vs.version === parsed.version),
  )
  if (matches.length === 0) return null
  if (matches.length > 1) {
    const versions = matches.map((vs) => vs.version ?? '(none)').join(', ')
    fail(
      404,
      'not-found',
      `Value set '${canonical}' cannot be resolved to a single version; the server holds versions ${versions}. Pin the version in the canonical URL.`,
    )
  }
  return matches[0]
}

// Parse a failed response body as an OperationOutcome, or null.
function parseOutcome(text) {
  try {
    const body = JSON.parse(text)
    return body?.resourceType === 'OperationOutcome' && Array.isArray(body.issue) ? body : null
  } catch {
    return null
  }
}

// Whether a failed response reports the value set as unknown. tx.fhir.org
// answers HTTP 422 with an issue coded `not-found`, so the status alone is not
// enough.
function reportsNotFound(status, outcome) {
  return status === 404 || Boolean(outcome?.issue.some((i) => i.code === 'not-found'))
}

// Describe a failed response for a diagnostic: the outcome's issue text where
// there is one (tx.fhir.org puts the message in `details.text` and timing
// noise in `diagnostics`), otherwise the raw body.
function describeFailure(status, outcome, text) {
  const details = (outcome?.issue ?? []).map((i) => i.details?.text || i.diagnostics).filter(Boolean)
  return `HTTP ${status}: ${details.length > 0 ? details.join('; ') : text.slice(0, 500)}`
}

/**
 * Perform one `$expand` request against the terminology server.
 *
 * @returns {Promise<object>} the returned ValueSet.
 * @throws {Error} 404 when expanding by url and the server reports the value
 *   set unknown; 422 for any other failure. A posted (stored) value set has
 *   already resolved, so a failure to expand it - typically a code system the
 *   server does not hold - is always 422.
 */
async function expandRequest(config, canonical, { url, version, valueSet, offset }) {
  const base = config.terminologyServerUrl.replace(/\/+$/, '')
  let request
  if (valueSet) {
    const parameter = [
      { name: 'valueSet', resource: valueSet },
      { name: 'count', valueInteger: PAGE_SIZE },
      { name: 'offset', valueInteger: offset },
    ]
    request = new Request(`${base}/ValueSet/$expand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
      body: JSON.stringify({ resourceType: 'Parameters', parameter }),
    })
  } else {
    const params = new URLSearchParams({ url, count: String(PAGE_SIZE), offset: String(offset) })
    if (version !== null) params.set('valueSetVersion', version)
    request = new Request(`${base}/ValueSet/$expand?${params}`, {
      headers: { Accept: 'application/fhir+json' },
    })
  }

  let response
  let text
  try {
    response = await fetch(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    text = await response.text()
  } catch (err) {
    throw membershipError(
      canonical,
      `the terminology server at ${base} could not be reached (${err.message})`,
    )
  }

  if (!response.ok) {
    const outcome = parseOutcome(text)
    const failure = describeFailure(response.status, outcome, text)
    if (!valueSet && reportsNotFound(response.status, outcome)) {
      fail(
        404,
        'not-found',
        `Value set '${canonical}' not found on the terminology server at ${base} (${failure})`,
      )
    }
    throw membershipError(canonical, `the terminology server at ${base} failed (${failure})`)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw membershipError(canonical, `the terminology server at ${base} returned a body that is not JSON`)
  }
  if (body?.resourceType !== 'ValueSet' || !body.expansion) {
    throw membershipError(canonical, `the terminology server at ${base} returned no expansion`)
  }
  return body
}

/**
 * Expand a value set on the terminology server, paging until every member
 * has been fetched, and assemble the membership record.
 *
 * Paging stops when the entries fetched reach the expansion's `total`, or,
 * where the server reports no `total` (tx.fhir.org omits it for some value
 * sets), when a page comes back short of the page size. An empty page always
 * stops it.
 */
async function expandOnServer(config, canonical, target) {
  const maxMembers = config.terminologyMaxMembers ?? DEFAULT_TERMINOLOGY_MAX_MEMBERS
  const entries = []
  let first
  let offset = 0
  for (;;) {
    const page = await expandRequest(config, canonical, { ...target, offset })
    first ??= page
    const pageEntries = [...walkContains(page.expansion.contains)]
    entries.push(...pageEntries)
    if (entries.length > maxMembers) {
      throw membershipError(canonical, `it has more than ${maxMembers} members, the configured maximum`)
    }
    if (pageEntries.length === 0) break
    const total = page.expansion.total
    const complete = typeof total === 'number' ? entries.length >= total : pageEntries.length < PAGE_SIZE
    if (complete) break
    offset += pageEntries.length
  }
  return membership(canonical, first, expansionRows({ contains: entries }), config.terminologyServerUrl)
}

// Assemble the record returned for a resolved value set.
function membership(canonical, valueSet, rows, source) {
  const expansion = valueSet.expansion || {}
  return {
    canonical,
    resolvedUrl: valueSet.url ?? parseCanonical(canonical).url,
    resolvedVersion: valueSet.version ?? null,
    source,
    identifier: expansion.identifier ?? null,
    timestamp: expansion.timestamp ?? null,
    parameters: expansion.parameter ?? [],
    rows,
  }
}

/**
 * Resolve a ValueSet canonical URL to its membership.
 *
 * Resolution order:
 *   1. A ValueSet stored on this server whose `url` (and `version`, where the
 *      canonical pins one) matches. Its `expansion` is used when present;
 *      otherwise the resource is posted to the terminology server's `$expand`.
 *   2. `GET ValueSet/$expand?url=…` on the terminology server, with
 *      `valueSetVersion` where pinned, paging until the expansion is complete.
 *
 * @param {string} canonical - Canonical URL of the value set, optionally `|version`.
 * @param {object} config - Server config carrying `terminologyServerUrl` and
 *   optionally `terminologyMaxMembers` and a `search` override.
 * @returns {Promise<{canonical: string, resolvedUrl: string, resolvedVersion: string|null, source: string, identifier: string|null, timestamp: string|null, parameters: object[], rows: object[]}>}
 *   the membership: `rows` in relation form, `source` as `'stored'` or the
 *   terminology server URL, and the expansion metadata that produced it.
 * @throws {Error} 404 when the canonical resolves to nothing or to several
 *   versions; 422 when membership cannot be determined.
 * @example
 * const { rows } = await resolveValueSet('http://example.org/ValueSet/diabetes|2026', config)
 * // rows[0] => { system, version, code, display, inactive }
 */
export async function resolveValueSet(canonical, config) {
  const stored = await findStoredValueSet(config, canonical)
  if (stored?.expansion) {
    assertCompleteExpansion(stored.expansion, canonical)
    return membership(canonical, stored, expansionRows(stored.expansion), 'stored')
  }
  if (stored) {
    return expandOnServer(config, canonical, { valueSet: stored })
  }
  return expandOnServer(config, canonical, parseCanonical(canonical))
}

/**
 * Write the one-line provenance record for a resolved value set dependency.
 *
 * @param {string} label - SQL identifier the relation is bound to.
 * @param {object} record - Result of `resolveValueSet`.
 */
export function logValueSetResolution(label, record) {
  // Servers report the code system versions used under `version`,
  // `system-version` or `used-codesystem`, sometimes under more than one.
  const versions = new Set(
    record.parameters
      .filter((p) => p.name === 'version' || p.name === 'system-version' || p.name === 'used-codesystem')
      .map((p) => p.valueUri ?? p.valueString ?? p.valueCanonical)
      .filter(Boolean),
  )
  console.log(
    `value set resolved: label=${label} canonical=${record.canonical} resolved=${record.resolvedUrl}|${record.resolvedVersion ?? ''} source=${record.source} expansion=${record.identifier ?? '-'} timestamp=${record.timestamp ?? '-'} code_system_versions=[${[...versions].join(', ')}] members=${record.rows.length}`,
  )
}
