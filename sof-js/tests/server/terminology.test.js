/**
 * Unit tests for the terminology module: flattening a ValueSet expansion into
 * relation rows, the completeness check on stored expansions, and resolution
 * of a canonical URL to a membership via a stored ValueSet or a terminology
 * server.
 *
 * Author: John Grimes
 */

import {
  VALUE_SET_COLUMNS,
  expansionRows,
  assertCompleteExpansion,
  resolveValueSet,
} from '../../src/server/terminology.js'
import { startMockTerminologyServer } from './mockTerminologyServer.js'

const SCT = 'http://snomed.info/sct'
const SCT_VERSION = 'http://snomed.info/sct/900000000000207008/version/20260201'

// ---------------------------------------------------------------------------
// expansionRows
// ---------------------------------------------------------------------------

describe('expansionRows', () => {
  test('exposes the five relation columns in order with their FHIR types', () => {
    expect(VALUE_SET_COLUMNS.map((c) => c.name)).toEqual(['system', 'version', 'code', 'display', 'inactive'])
    expect(VALUE_SET_COLUMNS.map((c) => c.type)).toEqual(['uri', 'string', 'code', 'string', 'boolean'])
  })

  test('flattens nested entries and drops abstract grouping entries', () => {
    // The spec example: one abstract parent with two concrete children.
    const expansion = {
      total: 3,
      contains: [
        {
          abstract: true,
          display: 'Diabetes mellitus',
          contains: [
            { system: SCT, version: SCT_VERSION, code: '73211009', display: 'Diabetes mellitus' },
            {
              system: 'http://hl7.org/fhir/sid/icd-10',
              version: '2019',
              code: 'E11',
              display: 'Type 2 diabetes mellitus',
            },
          ],
        },
      ],
    }
    expect(expansionRows(expansion)).toEqual([
      { system: SCT, version: SCT_VERSION, code: '73211009', display: 'Diabetes mellitus', inactive: null },
      {
        system: 'http://hl7.org/fhir/sid/icd-10',
        version: '2019',
        code: 'E11',
        display: 'Type 2 diabetes mellitus',
        inactive: null,
      },
    ])
  })

  test('deduplicates a code listed under two parents into one row', () => {
    const child = { system: SCT, code: '1', display: 'One' }
    const expansion = {
      contains: [
        { abstract: true, display: 'A', contains: [child] },
        { abstract: true, display: 'B', contains: [{ ...child }] },
      ],
    }
    expect(expansionRows(expansion)).toHaveLength(1)
  })

  test('treats two null versions as equal when deduplicating', () => {
    const expansion = {
      contains: [
        { system: SCT, code: '1' },
        { system: SCT, code: '1', display: 'One again' },
      ],
    }
    expect(expansionRows(expansion)).toHaveLength(1)
  })

  test('keeps the same code under two different code system versions as two rows', () => {
    const expansion = {
      contains: [
        { system: SCT, version: 'v1', code: '1' },
        { system: SCT, version: 'v2', code: '1' },
      ],
    }
    expect(expansionRows(expansion)).toHaveLength(2)
  })

  test('carries inactive through as true and leaves it null when absent', () => {
    const expansion = {
      contains: [
        { system: SCT, code: 'active-one' },
        { system: SCT, code: 'old', inactive: true },
        { system: SCT, code: 'explicit-active', inactive: false },
      ],
    }
    expect(expansionRows(expansion).map((r) => r.inactive)).toEqual([null, true, false])
  })

  test('an expansion with no entries yields no rows', () => {
    expect(expansionRows({ total: 0 })).toEqual([])
    expect(expansionRows({ contains: [] })).toEqual([])
  })

  test('skips an entry that lacks a system or code, since neither column may be null', () => {
    const expansion = {
      contains: [{ system: SCT }, { code: 'no-system' }, { system: SCT, code: 'ok' }],
    }
    expect(expansionRows(expansion).map((r) => r.code)).toEqual(['ok'])
  })
})

// ---------------------------------------------------------------------------
// assertCompleteExpansion
// ---------------------------------------------------------------------------

describe('assertCompleteExpansion', () => {
  const canonical = 'http://example.org/ValueSet/x|1'

  test('accepts an expansion whose total equals the entry count at all depths', () => {
    const expansion = {
      total: 3,
      contains: [
        {
          abstract: true,
          contains: [
            { system: SCT, code: '1' },
            { system: SCT, code: '2' },
          ],
        },
      ],
    }
    expect(() => assertCompleteExpansion(expansion, canonical)).not.toThrow()
  })

  test('accepts an expansion that carries no total', () => {
    expect(() => assertCompleteExpansion({ contains: [{ system: SCT, code: '1' }] }, canonical)).not.toThrow()
  })

  test('accepts an expansion that echoes offset 0, as tx.fhir.org does for an unpaged expansion', () => {
    const expansion = { offset: 0, total: 1, contains: [{ system: SCT, code: '1' }] }
    expect(() => assertCompleteExpansion(expansion, canonical)).not.toThrow()
  })

  test('rejects an expansion carrying an offset with 422', () => {
    const expansion = { offset: 10, total: 1, contains: [{ system: SCT, code: '1' }] }
    expect(() => assertCompleteExpansion(expansion, canonical)).toThrow(
      expect.objectContaining({ status: 422, issues: [expect.objectContaining({ code: 'processing' })] }),
    )
  })

  test('rejects an expansion whose total exceeds its entries with 422 naming the canonical', () => {
    const expansion = { total: 5, contains: [{ system: SCT, code: '1' }] }
    let caught
    try {
      assertCompleteExpansion(expansion, canonical)
    } catch (err) {
      caught = err
    }
    expect(caught.status).toBe(422)
    expect(caught.message).toContain(canonical)
  })
})

// ---------------------------------------------------------------------------
// resolveValueSet
// ---------------------------------------------------------------------------

describe('resolveValueSet', () => {
  let tx

  beforeAll(async () => {
    tx = await startMockTerminologyServer({ pageSize: 2 })
  })

  afterAll(async () => {
    await tx.close()
  })

  beforeEach(() => {
    tx.requests.length = 0
  })

  // Build a config whose ValueSet search returns the supplied stored resources.
  function configWith(stored = [], overrides = {}) {
    return {
      terminologyServerUrl: tx.url,
      terminologyMaxMembers: 100000,
      search: async (_config, resourceType) => (resourceType === 'ValueSet' ? stored : []),
      ...overrides,
    }
  }

  const storedExpanded = {
    resourceType: 'ValueSet',
    url: 'http://example.org/ValueSet/stored',
    version: '2',
    expansion: {
      identifier: 'urn:uuid:stored',
      timestamp: '2026-01-01T00:00:00Z',
      total: 2,
      contains: [
        { system: SCT, code: '1', display: 'One' },
        { system: SCT, code: '2', display: 'Two' },
      ],
    },
  }

  test('uses the expansion of a stored ValueSet without contacting the terminology server', async () => {
    const result = await resolveValueSet('http://example.org/ValueSet/stored|2', configWith([storedExpanded]))
    expect(result.rows.map((r) => r.code)).toEqual(['1', '2'])
    expect(result.source).toBe('stored')
    expect(tx.requests).toHaveLength(0)
  })

  test('matches a stored ValueSet by url alone when the dependency is unpinned', async () => {
    const result = await resolveValueSet('http://example.org/ValueSet/stored', configWith([storedExpanded]))
    expect(result.rows).toHaveLength(2)
    expect(tx.requests).toHaveLength(0)
  })

  test('falls through to the terminology server when the pinned version is not stored', async () => {
    // Stored version is 2; the dependency pins 9, which only the server could
    // hold. The mock does not know this URL, so the outcome is 404, but the
    // point is that the server was asked with the pinned version.
    await expect(
      resolveValueSet('http://example.org/ValueSet/stored|9', configWith([storedExpanded])),
    ).rejects.toMatchObject({ status: 404 })
    expect(tx.requests).toHaveLength(1)
    expect(tx.requests[0].query).toMatchObject({
      url: 'http://example.org/ValueSet/stored',
      valueSetVersion: '9',
    })
  })

  test('rejects an unpinned dependency with 404 when two stored versions share the url', async () => {
    const stored = [storedExpanded, { ...storedExpanded, version: '3' }]
    await expect(
      resolveValueSet('http://example.org/ValueSet/stored', configWith(stored)),
    ).rejects.toMatchObject({
      status: 404,
      issues: [expect.objectContaining({ code: 'not-found' })],
    })
    expect(tx.requests).toHaveLength(0)
  })

  test('rejects a stored ValueSet with an incomplete expansion with 422', async () => {
    const incomplete = { ...storedExpanded, expansion: { ...storedExpanded.expansion, total: 10 } }
    await expect(
      resolveValueSet('http://example.org/ValueSet/stored|2', configWith([incomplete])),
    ).rejects.toMatchObject({ status: 422 })
  })

  test('posts a stored compose-only ValueSet to $expand', async () => {
    const composeOnly = {
      resourceType: 'ValueSet',
      url: 'http://example.org/ValueSet/compose-only',
      version: '1',
      compose: {
        include: [{ system: 'http://example.org/cs', concept: [{ code: 'x', display: 'X' }] }],
      },
    }
    const result = await resolveValueSet(
      'http://example.org/ValueSet/compose-only|1',
      configWith([composeOnly]),
    )
    expect(result.rows).toEqual([
      { system: 'http://example.org/cs', version: null, code: 'x', display: 'X', inactive: null },
    ])
    expect(result.source).toBe(tx.url)
    expect(tx.requests[0].method).toBe('POST')
    expect(tx.requests[0].path).toBe('/ValueSet/$expand')
    const posted = JSON.parse(tx.requests[0].body)
    expect(posted.parameter.find((p) => p.name === 'valueSet').resource.url).toBe(composeOnly.url)
  })

  test('a stored ValueSet the server cannot expand is 422, even when the server says not-found', async () => {
    // The value set itself resolved (it is stored here); what the server
    // cannot find is its code system, so membership is undeterminable rather
    // than the canonical unresolved.
    const unknownSystem = {
      resourceType: 'ValueSet',
      url: 'http://example.org/ValueSet/unknown-system',
      version: '1',
      compose: { include: [{ system: 'http://example.org/unknown-cs', concept: [{ code: 'x' }] }] },
    }
    let caught
    try {
      await resolveValueSet('http://example.org/ValueSet/unknown-system|1', configWith([unknownSystem]))
    } catch (err) {
      caught = err
    }
    expect(caught.status).toBe(422)
    expect(caught.issues[0].code).toBe('processing')
    expect(caught.message).toContain('http://example.org/unknown-cs')
  })

  test('expands by url on the terminology server, paging until the total is reached', async () => {
    const result = await resolveValueSet('http://example.org/ValueSet/paged|1', configWith())
    expect(result.rows.map((r) => r.code)).toEqual(['a', 'b', 'c', 'd', 'e'])
    // Five members at a page size of two is three GET requests with offsets 0, 2, 4.
    expect(tx.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'GET'])
    expect(tx.requests.map((r) => Number(r.query.offset || 0))).toEqual([0, 2, 4])
    expect(tx.requests.every((r) => r.query.valueSetVersion === '1')).toBe(true)
  })

  test('keeps paging while pages come back full when the server reports no total', async () => {
    const result = await resolveValueSet('http://example.org/ValueSet/large-no-total|1', configWith())
    expect(result.rows).toHaveLength(2500)
    // 1000, 1000, then a short page of 500 ends the loop.
    expect(tx.requests.map((r) => Number(r.query.offset || 0))).toEqual([0, 1000, 2000])
  })

  test('omits valueSetVersion for an unpinned dependency', async () => {
    await resolveValueSet('http://hl7.org/fhir/ValueSet/administrative-gender', configWith())
    expect(tx.requests[0].query.valueSetVersion).toBeUndefined()
  })

  test('records what produced the membership', async () => {
    const result = await resolveValueSet(
      'http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1',
      configWith(),
    )
    expect(result.rows).toHaveLength(4)
    expect(result.source).toBe(tx.url)
    expect(result.resolvedVersion).toBe('4.0.1')
    expect(result.identifier).toBe('urn:uuid:mock-0')
    expect(result.timestamp).toBe('2026-09-16T00:00:00Z')
    expect(result.parameters).toEqual([
      { name: 'version', valueUri: 'http://hl7.org/fhir/administrative-gender|4.0.1' },
    ])
  })

  test('maps a terminology server 404 to a 404 naming the canonical', async () => {
    let caught
    try {
      await resolveValueSet('http://example.org/ValueSet/missing|1', configWith())
    } catch (err) {
      caught = err
    }
    expect(caught.status).toBe(404)
    expect(caught.issues[0].code).toBe('not-found')
    expect(caught.message).toContain('http://example.org/ValueSet/missing|1')
  })

  test('maps a 422 whose issue is coded not-found to a 404, as tx.fhir.org reports unknown value sets', async () => {
    await expect(
      resolveValueSet('http://example.org/ValueSet/unknown-as-422', configWith()),
    ).rejects.toMatchObject({ status: 404, issues: [expect.objectContaining({ code: 'not-found' })] })
  })

  test('maps any other terminology server failure to 422 with the server diagnostics', async () => {
    let caught
    try {
      await resolveValueSet('http://example.org/ValueSet/broken', configWith())
    } catch (err) {
      caught = err
    }
    expect(caught.status).toBe(422)
    expect(caught.issues[0].code).toBe('processing')
    expect(caught.message).toContain('Simulated terminology server failure')
  })

  test('maps an unreachable terminology server to 422', async () => {
    const unreachable = configWith([], { terminologyServerUrl: 'http://127.0.0.1:1' })
    await expect(resolveValueSet('http://example.org/ValueSet/paged|1', unreachable)).rejects.toMatchObject({
      status: 422,
    })
  })

  test('rejects a membership larger than the configured cap with 422', async () => {
    const capped = configWith([], { terminologyMaxMembers: 3 })
    await expect(resolveValueSet('http://example.org/ValueSet/paged|1', capped)).rejects.toMatchObject({
      status: 422,
    })
  })
})
