/**
 * ValueSet and ConceptMap dependencies of SQLQuery and SQLView Libraries.
 *
 * A `relatedArtifact[depends-on]` whose canonical URL names a ValueSet is
 * exposed to the SQL as a relation with the columns `system`, `version`,
 * `code`, `display` and `inactive`, one row per member of the value set. One
 * naming a ConceptMap is exposed as a relation with one row per mapping, from
 * `source_system` to `relationship`. This module resolves a canonical URL to
 * that content: from an artifact supplied inline in the request's `context`,
 * from one stored on this server, or from the configured FHIR terminology
 * server via `ValueSet/$expand` or a `ConceptMap` search.
 *
 * See the "Terminology in SQL" page of the SQL on FHIR specification.
 *
 * Author: John Grimes
 */

import { searchAll } from './db.js'
import { fail, operationError, issue, parseCanonical } from './common.js'

/** Default terminology server, used when `TERMINOLOGY_SERVER_URL` is unset. */
export const DEFAULT_TERMINOLOGY_SERVER_URL = 'https://tx.fhir.org/r5'

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

/**
 * Columns of the relation a ConceptMap dependency is exposed as, in order,
 * with the FHIR type each carries.
 */
export const CONCEPT_MAP_COLUMNS = [
  { name: 'source_system', type: 'uri' },
  { name: 'source_version', type: 'string' },
  { name: 'source_code', type: 'code' },
  { name: 'source_display', type: 'string' },
  { name: 'target_system', type: 'uri' },
  { name: 'target_version', type: 'string' },
  { name: 'target_code', type: 'code' },
  { name: 'target_display', type: 'string' },
  { name: 'relationship', type: 'code' },
]

// Visit every `contains` entry of an expansion at any depth.
function* walkContains(entries) {
  for (const entry of entries || []) {
    yield entry
    if (Array.isArray(entry.contains)) yield* walkContains(entry.contains)
  }
}

// A string value, or null for anything else.
function stringOrNull(value) {
  return typeof value === 'string' ? value : null
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
    const version = stringOrNull(entry.version)
    const key = `${entry.system}\u0000${version ?? ''}\u0000${entry.code}`
    if (rows.has(key)) continue
    rows.set(key, {
      system: entry.system,
      version,
      code: entry.code,
      display: stringOrNull(entry.display),
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
 * Reject an expansion that does not determine membership: one carrying an
 * `offset`, or whose `total` exceeds the number of entries at all depths.
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

function mappingsError(canonical, reason) {
  return operationError(422, [
    issue('processing', `The mappings of concept map '${canonical}' cannot be determined: ${reason}.`),
  ])
}

// Split a canonical into the system and version columns of a relation row; an
// absent canonical gives two nulls.
function systemAndVersion(canonical) {
  if (typeof canonical !== 'string') return { system: null, version: null }
  const { url, version } = parseCanonical(canonical)
  return { system: url, version }
}

// Reject a `target` of a ConceptMap element that no flat row can represent.
function assertRepresentableTarget(target, path, canonical) {
  if (target.valueSet != null) {
    throw mappingsError(canonical, `${path} carries valueSet, a mapping to a set rather than a code`)
  }
  if (target.dependsOn != null) {
    throw mappingsError(canonical, `${path} carries dependsOn, a mapping conditional on another attribute`)
  }
  if (target.product != null) {
    throw mappingsError(canonical, `${path} carries product, a mapping with further outputs`)
  }
  if (typeof target.code !== 'string') {
    throw mappingsError(canonical, `${path} has no code`)
  }
  if (typeof target.relationship !== 'string') {
    const hint =
      target.equivalence != null
        ? '; it carries equivalence, so the map is in the FHIR R4 format, which this server does not read'
        : ''
    throw mappingsError(canonical, `${path} has no relationship${hint}`)
  }
}

/**
 * Flatten a ConceptMap into relation rows: one row per `group.element.target`,
 * and one per `group.element` whose `noMap` is true with the target code,
 * display and relationship null. `group.source` and `group.target` are split
 * at `|` into system and version. Rows are unique on every column but the two
 * displays, two nulls counting as equal. `group.unmapped` contributes nothing.
 *
 * @param {object} conceptMap - A ConceptMap resource.
 * @param {string} canonical - The dependency's canonical URL, for diagnostics.
 * @returns {Array<object>} the relation rows, keyed by the `CONCEPT_MAP_COLUMNS`
 *   names, in document order.
 * @throws {Error} 422 when the map has a group without `source`, an element or
 *   target carrying `valueSet`, a target carrying `dependsOn` or `product`, or
 *   an element or target with no `code` or a target with no `relationship`.
 * @example
 * conceptMapRows({ group: [{ source: 'http://snomed.info/sct', target: 'http://hl7.org/fhir/sid/icd-10|2019',
 *   element: [{ code: '22298006', target: [{ code: 'I21', relationship: 'equivalent' }] }] }] }, canonical)
 * // => [{ source_system: 'http://snomed.info/sct', source_version: null, source_code: '22298006', ...,
 * //       target_version: '2019', target_code: 'I21', relationship: 'equivalent' }]
 */
export function conceptMapRows(conceptMap, canonical) {
  const rows = new Map()
  const add = (row) => {
    const key = [
      row.source_system,
      row.source_version,
      row.source_code,
      row.target_system,
      row.target_version,
      row.target_code,
      row.relationship,
    ].join('\u0000')
    if (!rows.has(key)) rows.set(key, row)
  }

  ;(conceptMap.group || []).forEach((group, g) => {
    if (typeof group.source !== 'string') {
      throw mappingsError(canonical, `group[${g}] has no source, so its codes have no system`)
    }
    const source = systemAndVersion(group.source)
    const target = systemAndVersion(group.target)
    ;(group.element || []).forEach((element, e) => {
      const path = `group[${g}].element[${e}]`
      if (element.valueSet != null) {
        throw mappingsError(canonical, `${path} carries valueSet, a mapping from a set rather than a code`)
      }
      if (typeof element.code !== 'string') throw mappingsError(canonical, `${path} has no code`)
      const from = {
        source_system: source.system,
        source_version: source.version,
        source_code: element.code,
        source_display: stringOrNull(element.display),
        target_system: target.system,
        target_version: target.version,
      }
      ;(element.target || []).forEach((t, i) => {
        assertRepresentableTarget(t, `${path}.target[${i}]`, canonical)
        add({
          ...from,
          target_code: t.code,
          target_display: stringOrNull(t.display),
          relationship: t.relationship,
        })
      })
      if (element.noMap === true) {
        add({ ...from, target_code: null, target_display: null, relationship: null })
      }
    })
  })
  return [...rows.values()]
}

/**
 * Find the stored artifact of a type matching a canonical URL. A pinned
 * dependency matches on url and version; an unpinned one on url alone, and
 * fails when more than one version is stored, since the runner then cannot
 * decide.
 *
 * @param {object} config - Server config, optionally with a `search` override.
 * @param {'ValueSet'|'ConceptMap'} resourceType - The type to search.
 * @param {string} canonical - Canonical URL, optionally `|version`.
 * @returns {Promise<object|null>} the resource, or null when none matches.
 * @throws {Error} 404 when an unpinned url matches several stored versions.
 */
export async function findStored(config, resourceType, canonical) {
  const parsed = parseCanonical(canonical)
  const searchFn = typeof config.search === 'function' ? config.search : searchAll
  const all = await searchFn(config, resourceType)
  const matches = all.filter(
    (r) => r.url === parsed.url && (parsed.version === null || r.version === parsed.version),
  )
  if (matches.length === 0) return null
  if (matches.length > 1) {
    const versions = matches.map((r) => r.version ?? '(none)').join(', ')
    fail(
      404,
      'not-found',
      `${resourceType} '${canonical}' cannot be resolved to a single version; the server holds versions ${versions}. Pin the version in the canonical URL.`,
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

// Whether a failed response reports the artifact as unknown. tx.fhir.org
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

// The terminology server base URL, without a trailing slash.
function serverBase(config) {
  return config.terminologyServerUrl.replace(/\/+$/, '')
}

// Send one request to the terminology server and read its body. An
// unreachable server is reported through `unreachable`, which builds the error.
async function send(request, unreachable) {
  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    return { response, text: await response.text() }
  } catch (err) {
    throw unreachable(err.message)
  }
}

/**
 * Perform one `$expand` request against the terminology server.
 *
 * @returns {Promise<object>} the returned ValueSet.
 * @throws {Error} 404 when expanding by url and the server reports the value
 *   set unknown; 422 for any other failure. A posted value set has already
 *   resolved, so a failure to expand it - typically a code system the server
 *   does not hold - is always 422.
 */
async function expandRequest(config, canonical, { url, version, valueSet, offset }) {
  const base = serverBase(config)
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

  const { response, text } = await send(request, (message) =>
    membershipError(canonical, `the terminology server at ${base} could not be reached (${message})`),
  )
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

// Determine the membership of a ValueSet resource in hand: from its expansion
// where it carries one, otherwise by posting it to the terminology server.
async function valueSetMembership(config, canonical, valueSet, source) {
  if (valueSet.expansion) {
    assertCompleteExpansion(valueSet.expansion, canonical)
    return membership(canonical, valueSet, expansionRows(valueSet.expansion), source)
  }
  return expandOnServer(config, canonical, { valueSet })
}

// Assemble the record returned for a resolved concept map.
function mappings(canonical, conceptMap, source) {
  return {
    canonical,
    resolvedUrl: conceptMap.url ?? parseCanonical(canonical).url,
    resolvedVersion: conceptMap.version ?? null,
    source,
    rows: conceptMapRows(conceptMap, canonical),
  }
}

/**
 * Search the terminology server for the ConceptMap with a canonical URL.
 *
 * @returns {Promise<object|null>} the ConceptMap, or null when the server holds none.
 * @throws {Error} 404 when an unpinned url matches several versions; 422 when
 *   the search fails.
 */
async function searchConceptMapOnServer(config, canonical) {
  const base = serverBase(config)
  const { url, version } = parseCanonical(canonical)
  const params = new URLSearchParams({ url })
  if (version !== null) params.set('version', version)
  const request = new Request(`${base}/ConceptMap?${params}`, {
    headers: { Accept: 'application/fhir+json' },
  })

  const { response, text } = await send(request, (message) =>
    mappingsError(canonical, `the terminology server at ${base} could not be reached (${message})`),
  )
  if (!response.ok) {
    const outcome = parseOutcome(text)
    if (reportsNotFound(response.status, outcome)) return null
    throw mappingsError(
      canonical,
      `the terminology server at ${base} failed (${describeFailure(response.status, outcome, text)})`,
    )
  }
  let bundle
  try {
    bundle = JSON.parse(text)
  } catch {
    throw mappingsError(canonical, `the terminology server at ${base} returned a body that is not JSON`)
  }
  // Keep search matches only, rechecking url and version rather than trusting
  // the server to have applied both parameters.
  const matches = (bundle?.entry || [])
    .filter((e) => e.search?.mode !== 'include' && e.resource?.resourceType === 'ConceptMap')
    .map((e) => e.resource)
    .filter((cm) => cm.url === url && (version === null || cm.version === version))
  if (matches.length === 0) return null
  if (matches.length > 1) {
    const versions = matches.map((cm) => cm.version ?? '(none)').join(', ')
    fail(
      404,
      'not-found',
      `ConceptMap '${canonical}' cannot be resolved to a single version; the terminology server at ${base} holds versions ${versions}. Pin the version in the canonical URL.`,
    )
  }
  return matches[0]
}

/**
 * Resolve a ValueSet or ConceptMap dependency to the content its relation is
 * built from.
 *
 * Resolution order:
 *   1. The artifact `supplied` in the request's `context`, already matched to
 *      the dependency. A ValueSet's `expansion` is used when present;
 *      otherwise the resource is posted to the terminology server's `$expand`.
 *   2. A ValueSet stored on this server whose `url` (and `version`, where the
 *      canonical pins one) matches, used in the same way.
 *   3. A ConceptMap stored on this server that matches.
 *   4. `GET ValueSet/$expand?url=…` on the terminology server, with
 *      `valueSetVersion` where pinned, paging until the expansion is complete.
 *   5. Where the terminology server reports the value set unknown,
 *      `GET ConceptMap?url=…` on it, with `version` where pinned.
 *
 * @param {string} canonical - Canonical URL of the dependency, optionally `|version`.
 * @param {object} config - Server config carrying `terminologyServerUrl` and
 *   optionally `terminologyMaxMembers` and a `search` override.
 * @param {object} [supplied] - A ValueSet or ConceptMap supplied inline for this dependency.
 * @returns {Promise<{kind: 'ValueSet'|'ConceptMap', resource: object}>} the
 *   resolution. A ValueSet's `resource` is its membership record (`rows` plus
 *   the expansion metadata that produced them); a ConceptMap's carries its
 *   `rows`. Both record `canonical`, `resolvedUrl`, `resolvedVersion` and
 *   `source`: `'context'`, `'stored'` or the terminology server URL.
 * @throws {Error} 404 when the canonical resolves to nothing or to several
 *   versions; 422 when the content cannot be determined.
 * @example
 * const { kind, resource } = await resolveTerminology('http://example.org/ConceptMap/sct-to-icd10|2026', config)
 * // kind => 'ConceptMap'; resource.rows[0] => { source_system, ..., relationship }
 */
export async function resolveTerminology(canonical, config, supplied) {
  if (supplied?.resourceType === 'ConceptMap') {
    return { kind: 'ConceptMap', resource: mappings(canonical, supplied, 'context') }
  }
  if (supplied) {
    return { kind: 'ValueSet', resource: await valueSetMembership(config, canonical, supplied, 'context') }
  }

  const storedValueSet = await findStored(config, 'ValueSet', canonical)
  if (storedValueSet) {
    return {
      kind: 'ValueSet',
      resource: await valueSetMembership(config, canonical, storedValueSet, 'stored'),
    }
  }
  const storedConceptMap = await findStored(config, 'ConceptMap', canonical)
  if (storedConceptMap) {
    return { kind: 'ConceptMap', resource: mappings(canonical, storedConceptMap, 'stored') }
  }

  let notValueSet
  try {
    return { kind: 'ValueSet', resource: await expandOnServer(config, canonical, parseCanonical(canonical)) }
  } catch (err) {
    if (err.status !== 404) throw err
    notValueSet = err
  }
  const conceptMap = await searchConceptMapOnServer(config, canonical)
  if (conceptMap) {
    return { kind: 'ConceptMap', resource: mappings(canonical, conceptMap, config.terminologyServerUrl) }
  }
  fail(
    404,
    'not-found',
    `'${canonical}' is neither a ValueSet nor a ConceptMap known to the terminology server at ${serverBase(config)} (${notValueSet.message})`,
  )
}

/**
 * Write the one-line provenance record for a resolved terminology dependency.
 *
 * @param {string} label - SQL identifier the relation is bound to.
 * @param {{kind: 'ValueSet'|'ConceptMap', resource: object}} resolution - Result of `resolveTerminology`.
 */
export function logTerminologyResolution(label, { kind, resource: record }) {
  const resolved = `${record.resolvedUrl}|${record.resolvedVersion ?? ''}`
  if (kind === 'ConceptMap') {
    console.log(
      `concept map resolved: label=${label} canonical=${record.canonical} resolved=${resolved} source=${record.source} mappings=${record.rows.length}`,
    )
    return
  }
  // Servers report the code system versions used under `version`,
  // `system-version` or `used-codesystem`, sometimes under more than one.
  const versions = new Set(
    record.parameters
      .filter((p) => p.name === 'version' || p.name === 'system-version' || p.name === 'used-codesystem')
      .map((p) => p.valueUri ?? p.valueString ?? p.valueCanonical)
      .filter(Boolean),
  )
  console.log(
    `value set resolved: label=${label} canonical=${record.canonical} resolved=${resolved} source=${record.source} expansion=${record.identifier ?? '-'} timestamp=${record.timestamp ?? '-'} code_system_versions=[${[...versions].join(', ')}] members=${record.rows.length}`,
  )
}
