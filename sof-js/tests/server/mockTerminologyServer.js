/**
 * Minimal FHIR terminology server double for tests. Implements
 * `GET ValueSet/$expand?url=…` and `POST ValueSet/$expand` with paging over a
 * fixed set of value sets, and records every request it receives.
 *
 * Author: John Grimes
 */

import http from 'http'

const GENDER_SYSTEM = 'http://hl7.org/fhir/administrative-gender'

// Value sets the mock knows about. Each entry lists the versions the server
// holds; `null` is the version served for an unpinned request.
const valueSets = {
  'http://hl7.org/fhir/ValueSet/administrative-gender': {
    latest: '4.0.1',
    versions: {
      '4.0.1': {
        parameter: [{ name: 'version', valueUri: `${GENDER_SYSTEM}|4.0.1` }],
        contains: [
          { system: GENDER_SYSTEM, version: '4.0.1', code: 'male', display: 'Male' },
          { system: GENDER_SYSTEM, version: '4.0.1', code: 'female', display: 'Female' },
          { system: GENDER_SYSTEM, version: '4.0.1', code: 'other', display: 'Other' },
          { system: GENDER_SYSTEM, version: '4.0.1', code: 'unknown', display: 'Unknown' },
        ],
      },
      // An older version with fewer members, so a pinned request is
      // distinguishable from an unpinned one by its row count.
      '3.0.0': {
        parameter: [{ name: 'version', valueUri: `${GENDER_SYSTEM}|3.0.0` }],
        contains: [
          { system: GENDER_SYSTEM, version: '3.0.0', code: 'male', display: 'Male' },
          { system: GENDER_SYSTEM, version: '3.0.0', code: 'female', display: 'Female' },
        ],
      },
    },
  },
  // Five members so that a page size of two yields three pages.
  'http://example.org/ValueSet/paged': {
    latest: '1',
    versions: {
      1: {
        parameter: [],
        contains: ['a', 'b', 'c', 'd', 'e'].map((code) => ({
          system: 'http://example.org/cs',
          code,
          display: code.toUpperCase(),
        })),
      },
    },
  },
  // A value set with an inactive member, so the `inactive` column is exercised
  // end to end.
  'http://example.org/ValueSet/with-inactive': {
    latest: '1',
    versions: {
      1: {
        parameter: [],
        contains: [
          { system: 'http://example.org/cs', code: 'live', display: 'Live' },
          { system: 'http://example.org/cs', code: 'retired', display: 'Retired', inactive: true },
        ],
      },
    },
  },
  // 2500 members served 1000 at a time with no `total`, as tx.fhir.org does
  // for some value sets, so paging must continue until a short page.
  'http://example.org/ValueSet/large-no-total': {
    latest: '1',
    pageSize: 1000,
    omitTotal: true,
    versions: {
      1: {
        parameter: [],
        contains: Array.from({ length: 2500 }, (_, i) => ({
          system: 'http://example.org/cs',
          code: `c${i}`,
        })),
      },
    },
  },
}

function operationOutcome(code, diagnostics) {
  return JSON.stringify({
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code, diagnostics }],
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

/**
 * Start the mock terminology server on an ephemeral port.
 *
 * @param {object} [options]
 * @param {number} [options.pageSize=2] - Maximum `contains` entries per page,
 *   regardless of the `count` the client asks for.
 * @returns {Promise<{url: string, requests: object[], close: () => Promise<void>}>}
 *   the base URL, the recorded requests, and a shutdown function.
 */
export async function startMockTerminologyServer({ pageSize = 2 } = {}) {
  const requests = []

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const body = req.method === 'POST' ? await readBody(req) : null
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    }
    requests.push(record)

    if (url.pathname !== '/ValueSet/$expand') {
      res.writeHead(404, { 'Content-Type': 'application/fhir+json' })
      res.end(operationOutcome('not-found', `Unknown path ${url.pathname}`))
      return
    }

    let vsUrl
    let vsVersion
    let offset
    let inlineValueSet
    if (req.method === 'GET') {
      vsUrl = url.searchParams.get('url')
      vsVersion = url.searchParams.get('valueSetVersion')
      offset = Number(url.searchParams.get('offset') || 0)
    } else {
      const params = JSON.parse(body)
      const part = (name) => (params.parameter || []).find((p) => p.name === name)
      inlineValueSet = part('valueSet')?.resource
      vsUrl = inlineValueSet?.url
      vsVersion = inlineValueSet?.version || null
      offset = Number(part('offset')?.valueInteger || 0)
    }

    // A URL the mock has been told to fail on simulates a server-side fault.
    if (vsUrl === 'http://example.org/ValueSet/broken') {
      res.writeHead(500, { 'Content-Type': 'application/fhir+json' })
      res.end(operationOutcome('exception', 'Simulated terminology server failure'))
      return
    }

    // tx.fhir.org reports an unknown value set as HTTP 422 with an issue
    // coded `not-found` rather than as HTTP 404.
    if (vsUrl === 'http://example.org/ValueSet/unknown-as-422') {
      res.writeHead(422, { 'Content-Type': 'application/fhir+json' })
      res.end(operationOutcome('not-found', `ValueSet not found: ${vsUrl}`))
      return
    }

    // A posted value set with a compose is "expanded" by echoing the codes in
    // its compose.include[].concept[] entries, so that a stored compose-only
    // ValueSet round-trips through the mock with a recognisable result. A
    // compose that includes a code system the mock does not know fails the
    // way tx.fhir.org does: HTTP 422 with an issue coded `not-found`.
    let members
    let versionParams = []
    let servedVersion = vsVersion
    let entry
    if (inlineValueSet && !valueSets[vsUrl]) {
      const includes = inlineValueSet.compose?.include || []
      const unknown = includes.find((inc) => inc.system === 'http://example.org/unknown-cs')
      if (unknown) {
        res.writeHead(422, { 'Content-Type': 'application/fhir+json' })
        res.end(
          operationOutcome('not-found', `A definition for CodeSystem ${unknown.system} could not be found`),
        )
        return
      }
      members = includes.flatMap((inc) =>
        (inc.concept || []).map((c) => ({ system: inc.system, code: c.code, display: c.display })),
      )
    } else {
      entry = valueSets[vsUrl]
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/fhir+json' })
        res.end(operationOutcome('not-found', `Unable to find value set ${vsUrl}`))
        return
      }
      servedVersion = vsVersion || entry.latest
      const version = entry.versions[servedVersion]
      if (!version) {
        res.writeHead(404, { 'Content-Type': 'application/fhir+json' })
        res.end(operationOutcome('not-found', `Unable to find value set ${vsUrl} version ${vsVersion}`))
        return
      }
      members = version.contains
      versionParams = version.parameter
    }

    const page = members.slice(offset, offset + (entry?.pageSize ?? pageSize))
    const expansion = {
      identifier: `urn:uuid:mock-${offset}`,
      timestamp: '2026-09-16T00:00:00Z',
      parameter: versionParams,
      contains: page,
    }
    if (!entry?.omitTotal) expansion.total = members.length
    if (offset > 0) expansion.offset = offset
    res.writeHead(200, { 'Content-Type': 'application/fhir+json' })
    res.end(
      JSON.stringify({
        resourceType: 'ValueSet',
        url: vsUrl,
        version: servedVersion,
        status: 'active',
        expansion,
      }),
    )
  })

  await new Promise((resolve) => server.listen(0, resolve))
  const { port } = server.address()
  return {
    url: `http://localhost:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
