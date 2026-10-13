/**
 * Unit tests for the terminology module: flattening a ValueSet expansion or a
 * ConceptMap into relation rows, the completeness check on stored expansions,
 * and resolution of a canonical URL to a membership or a set of mappings via a
 * supplied artifact, a stored artifact or a terminology server.
 *
 * Author: John Grimes
 */

import {
  VALUE_SET_COLUMNS,
  CONCEPT_MAP_COLUMNS,
  expansionRows,
  conceptMapRows,
  assertCompleteExpansion,
  resolveTerminology,
} from '../../src/server/terminology.js'
import { startMockTerminologyServer } from './mockTerminologyServer.js'
import { ICD10, SCT_TO_ICD10_ROWS, sctToIcd10Map } from './conceptMapFixtures.js'

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
// conceptMapRows
// ---------------------------------------------------------------------------

describe('conceptMapRows', () => {
  const CANONICAL = 'http://example.org/ConceptMap/sct-to-icd10|2026'

  // A one-group map whose single element carries the given element fields.
  function mapWithElement(element, group = {}) {
    return {
      resourceType: 'ConceptMap',
      url: 'http://example.org/ConceptMap/m',
      group: [{ source: SCT, target: ICD10, element: [{ code: 'x', ...element }], ...group }],
    }
  }

  // Expect conceptMapRows to reject the map with a 422 whose diagnostics
  // mention the given text.
  function expectUnrepresentable(map, mention) {
    let caught
    try {
      conceptMapRows(map, CANONICAL)
    } catch (err) {
      caught = err
    }
    expect(caught?.status).toBe(422)
    expect(caught.issues[0].code).toBe('processing')
    expect(caught.message).toContain(CANONICAL)
    expect(caught.message).toContain(mention)
  }

  test('exposes the nine relation columns in order with their FHIR types', () => {
    expect(CONCEPT_MAP_COLUMNS.map((c) => c.name)).toEqual([
      'source_system',
      'source_version',
      'source_code',
      'source_display',
      'target_system',
      'target_version',
      'target_code',
      'target_display',
      'relationship',
    ])
    expect(CONCEPT_MAP_COLUMNS.map((c) => c.type)).toEqual([
      'uri',
      'string',
      'code',
      'string',
      'uri',
      'string',
      'code',
      'string',
      'code',
    ])
  })

  test('produces the rows of the specification worked example', () => {
    // One row per target and one per noMap element; group.target is split at
    // `|` and the unversioned group.source gives a null source_version.
    expect(conceptMapRows(sctToIcd10Map(), CANONICAL)).toEqual(SCT_TO_ICD10_ROWS)
  })

  test('gives an element with several targets one row per target', () => {
    const map = mapWithElement({
      target: [
        { code: 'A', relationship: 'source-is-broader-than-target' },
        { code: 'B', relationship: 'source-is-broader-than-target' },
      ],
    })
    expect(conceptMapRows(map, CANONICAL).map((r) => r.target_code)).toEqual(['A', 'B'])
  })

  test('splits a versioned group.source into source_system and source_version', () => {
    const map = mapWithElement(
      { target: [{ code: 'A', relationship: 'equivalent' }] },
      { source: `${SCT}|${SCT_VERSION}` },
    )
    expect(conceptMapRows(map, CANONICAL)[0]).toMatchObject({
      source_system: SCT,
      source_version: SCT_VERSION,
      target_system: ICD10,
      target_version: null,
    })
  })

  test('a noMap element in a group without a target has a null target_system', () => {
    const map = mapWithElement({ noMap: true }, { target: undefined })
    expect(conceptMapRows(map, CANONICAL)).toEqual([
      {
        source_system: SCT,
        source_version: null,
        source_code: 'x',
        source_display: null,
        target_system: null,
        target_version: null,
        target_code: null,
        target_display: null,
        relationship: null,
      },
    ])
  })

  test('rows from several groups are concatenated in group order', () => {
    const map = mapWithElement({ target: [{ code: 'A', relationship: 'equivalent' }] })
    map.group.push({
      source: SCT,
      target: 'http://example.org/other',
      element: [{ code: 'x', target: [{ code: 'Z', relationship: 'related-to' }] }],
    })
    expect(conceptMapRows(map, CANONICAL).map((r) => [r.target_system, r.target_code])).toEqual([
      [ICD10, 'A'],
      ['http://example.org/other', 'Z'],
    ])
  })

  test('collapses two identical mappings into one row, two null values counting as equal', () => {
    // term-15: the same source and target listed twice (here under two
    // groups with identical unversioned systems) is one row.
    const map = mapWithElement({ target: [{ code: 'A', relationship: 'equivalent' }] })
    map.group.push(structuredClone(map.group[0]))
    map.group[1].element[0].display = 'Different display, same mapping'
    map.group.push(mapWithElement({ noMap: true }).group[0])
    map.group.push(mapWithElement({ noMap: true }).group[0])
    const rows = conceptMapRows(map, CANONICAL)
    expect(rows.map((r) => r.target_code)).toEqual(['A', null])
  })

  test('keeps one source mapped to the same target under two relationships as two rows', () => {
    const map = mapWithElement({
      target: [
        { code: 'A', relationship: 'equivalent' },
        { code: 'A', relationship: 'related-to' },
      ],
    })
    expect(conceptMapRows(map, CANONICAL)).toHaveLength(2)
  })

  test('a map without groups, or with groups without elements, yields no rows', () => {
    expect(conceptMapRows({ resourceType: 'ConceptMap' }, CANONICAL)).toEqual([])
    expect(conceptMapRows({ resourceType: 'ConceptMap', group: [{ source: SCT }] }, CANONICAL)).toEqual([])
  })

  test('derives no rows from group.unmapped', () => {
    // term-17: the relation carries explicit mappings only.
    const map = mapWithElement(
      { target: [{ code: 'A', relationship: 'equivalent' }] },
      { unmapped: { mode: 'fixed', code: 'R69', relationship: 'related-to' } },
    )
    expect(conceptMapRows(map, CANONICAL).map((r) => r.target_code)).toEqual(['A'])
  })

  test('rejects a group without a source', () => {
    expectUnrepresentable(mapWithElement({ noMap: true }, { source: undefined }), 'group[0]')
  })

  test('rejects an element carrying valueSet in place of a code', () => {
    expectUnrepresentable(
      mapWithElement({ code: undefined, valueSet: 'http://example.org/ValueSet/s', noMap: true }),
      'valueSet',
    )
  })

  test('rejects a target carrying valueSet', () => {
    expectUnrepresentable(
      mapWithElement({ target: [{ valueSet: 'http://example.org/ValueSet/t', relationship: 'equivalent' }] }),
      'valueSet',
    )
  })

  test('rejects a target carrying dependsOn', () => {
    expectUnrepresentable(
      mapWithElement({
        target: [
          { code: 'A', relationship: 'equivalent', dependsOn: [{ attribute: 'site', valueCode: 'L' }] },
        ],
      }),
      'dependsOn',
    )
  })

  test('rejects a target carrying product', () => {
    expectUnrepresentable(
      mapWithElement({
        target: [{ code: 'A', relationship: 'equivalent', product: [{ attribute: 'site', valueCode: 'L' }] }],
      }),
      'product',
    )
  })

  test('rejects an element without a code', () => {
    expectUnrepresentable(mapWithElement({ code: undefined, noMap: true }), 'code')
  })

  test('rejects a target without a code, which would be indistinguishable from noMap', () => {
    expectUnrepresentable(mapWithElement({ target: [{ relationship: 'equivalent' }] }), 'code')
  })

  test('rejects an R4-shaped target carrying equivalence instead of relationship', () => {
    expectUnrepresentable(
      mapWithElement({ target: [{ code: 'A', equivalence: 'equivalent' }] }),
      'equivalence',
    )
  })
})

// ---------------------------------------------------------------------------
// resolveTerminology
// ---------------------------------------------------------------------------

describe('resolveTerminology', () => {
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

  // Build a config whose searches return the supplied stored resources of the
  // requested type.
  function configWith(stored = [], overrides = {}) {
    return {
      terminologyServerUrl: tx.url,
      terminologyMaxMembers: 100000,
      search: async (_config, resourceType) => stored.filter((r) => r.resourceType === resourceType),
      ...overrides,
    }
  }

  // Resolve a canonical that must turn out to be a value set, returning its
  // membership record.
  async function resolveValueSet(canonical, config, supplied) {
    const result = await resolveTerminology(canonical, config, supplied)
    expect(result.kind).toBe('ValueSet')
    return result.resource
  }

  // Resolve a canonical that must turn out to be a concept map, returning its
  // mappings record.
  async function resolveConceptMap(canonical, config, supplied) {
    const result = await resolveTerminology(canonical, config, supplied)
    expect(result.kind).toBe('ConceptMap')
    return result.resource
  }

  const expandRequests = () => tx.requests.filter((r) => r.path === '/ValueSet/$expand')

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
    expect(expandRequests()).toHaveLength(1)
    expect(expandRequests()[0].query).toMatchObject({
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
      'http://hl7.org/fhir/ValueSet/administrative-gender|5.0.0',
      configWith(),
    )
    expect(result.rows).toHaveLength(4)
    expect(result.source).toBe(tx.url)
    expect(result.resolvedVersion).toBe('5.0.0')
    expect(result.identifier).toBe('urn:uuid:mock-0')
    expect(result.timestamp).toBe('2026-09-16T00:00:00Z')
    expect(result.parameters).toEqual([
      { name: 'version', valueUri: 'http://hl7.org/fhir/administrative-gender|5.0.0' },
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

  // -------------------------------------------------------------------------
  // Supplied (context) value sets
  // -------------------------------------------------------------------------

  test('derives membership from a supplied expansion without contacting the terminology server', async () => {
    // term-23: a supplied expansion states the membership the client intends,
    // even where the server stores a different version of the same url.
    const supplied = {
      ...storedExpanded,
      expansion: { total: 1, contains: [{ system: SCT, code: 'only', display: 'Only' }] },
    }
    const result = await resolveValueSet(
      'http://example.org/ValueSet/stored|2',
      configWith([storedExpanded]),
      supplied,
    )
    expect(result.rows.map((r) => r.code)).toEqual(['only'])
    expect(result.source).toBe('context')
    expect(tx.requests).toHaveLength(0)
  })

  test('rejects a supplied expansion that is a page with 422', async () => {
    // term-24: an expansion carrying an offset does not determine membership.
    const supplied = { ...storedExpanded, expansion: { ...storedExpanded.expansion, offset: 2 } }
    await expect(
      resolveTerminology('http://example.org/ValueSet/stored|2', configWith(), supplied),
    ).rejects.toMatchObject({ status: 422, issues: [expect.objectContaining({ code: 'processing' })] })
  })

  test('rejects a supplied expansion whose total exceeds its entries with 422', async () => {
    const supplied = { ...storedExpanded, expansion: { ...storedExpanded.expansion, total: 3 } }
    await expect(
      resolveTerminology('http://example.org/ValueSet/stored|2', configWith(), supplied),
    ).rejects.toMatchObject({ status: 422 })
  })

  test('expands a supplied compose-only ValueSet on the terminology server', async () => {
    const supplied = {
      resourceType: 'ValueSet',
      url: 'http://example.org/ValueSet/inline-compose',
      compose: { include: [{ system: 'http://example.org/cs', concept: [{ code: 'y', display: 'Y' }] }] },
    }
    const result = await resolveValueSet('http://example.org/ValueSet/inline-compose', configWith(), supplied)
    expect(result.rows.map((r) => r.code)).toEqual(['y'])
    expect(result.source).toBe(tx.url)
    expect(tx.requests.map((r) => r.method)).toEqual(['POST'])
  })

  // -------------------------------------------------------------------------
  // Concept maps
  // -------------------------------------------------------------------------

  test('derives mappings from a supplied ConceptMap without contacting the terminology server', async () => {
    const result = await resolveConceptMap(
      'http://example.org/ConceptMap/sct-to-icd10|2026',
      configWith(),
      sctToIcd10Map(),
    )
    expect(result.rows).toEqual(SCT_TO_ICD10_ROWS)
    expect(result).toMatchObject({
      canonical: 'http://example.org/ConceptMap/sct-to-icd10|2026',
      resolvedUrl: 'http://example.org/ConceptMap/sct-to-icd10',
      resolvedVersion: '2026',
      source: 'context',
    })
    expect(tx.requests).toHaveLength(0)
  })

  test('rejects a supplied ConceptMap with a dependsOn target with 422, as for a resolved one', async () => {
    const map = sctToIcd10Map()
    map.group[0].element[0].target[0].dependsOn = [{ attribute: 'site', valueCode: 'left' }]
    await expect(
      resolveTerminology('http://example.org/ConceptMap/sct-to-icd10', configWith(), map),
    ).rejects.toMatchObject({ status: 422, issues: [expect.objectContaining({ code: 'processing' })] })
  })

  test('resolves a stored ConceptMap without contacting the terminology server', async () => {
    const result = await resolveConceptMap(
      'http://example.org/ConceptMap/sct-to-icd10|2026',
      configWith([sctToIcd10Map()]),
    )
    expect(result.rows).toEqual(SCT_TO_ICD10_ROWS)
    expect(result.source).toBe('stored')
    expect(tx.requests).toHaveLength(0)
  })

  test('matches a stored ConceptMap by url alone when the dependency is unpinned', async () => {
    const result = await resolveConceptMap(
      'http://example.org/ConceptMap/sct-to-icd10',
      configWith([sctToIcd10Map()]),
    )
    expect(result.resolvedVersion).toBe('2026')
  })

  test('rejects an unpinned ConceptMap with 404 when two stored versions share the url', async () => {
    const stored = [sctToIcd10Map(), { ...sctToIcd10Map(), version: '2027' }]
    await expect(
      resolveTerminology('http://example.org/ConceptMap/sct-to-icd10', configWith(stored)),
    ).rejects.toMatchObject({ status: 404, issues: [expect.objectContaining({ code: 'not-found' })] })
    expect(tx.requests).toHaveLength(0)
  })

  test('rejects a stored ConceptMap whose content the relation cannot represent with 422', async () => {
    const map = sctToIcd10Map()
    delete map.group[0].source
    await expect(
      resolveTerminology('http://example.org/ConceptMap/sct-to-icd10|2026', configWith([map])),
    ).rejects.toMatchObject({ status: 422 })
  })

  test('finds a ConceptMap on the terminology server once $expand reports the url unknown', async () => {
    const result = await resolveConceptMap('http://example.org/ConceptMap/remote|1', configWith())
    expect(result.rows.map((r) => [r.source_code, r.target_code, r.relationship])).toEqual([
      ['59621000', 'I10', 'equivalent'],
    ])
    expect(result.source).toBe(tx.url)
    expect(result.resolvedVersion).toBe('1')
    // The value set expansion is tried first, then the concept map search
    // with the pinned version.
    expect(tx.requests.map((r) => r.path)).toEqual(['/ValueSet/$expand', '/ConceptMap'])
    expect(tx.requests[1].query).toEqual({ url: 'http://example.org/ConceptMap/remote', version: '1' })
  })

  test('searches the terminology server without a version for an unpinned ConceptMap', async () => {
    await resolveConceptMap('http://example.org/ConceptMap/remote', configWith())
    expect(tx.requests[1].query).toEqual({ url: 'http://example.org/ConceptMap/remote' })
  })

  test('rejects an unpinned ConceptMap with 404 when the terminology server holds two versions', async () => {
    let caught
    try {
      await resolveTerminology('http://example.org/ConceptMap/two-versions', configWith())
    } catch (err) {
      caught = err
    }
    expect(caught.status).toBe(404)
    expect(caught.message).toContain('1, 2')
  })

  test('rejects an R4-shaped ConceptMap from the terminology server with 422', async () => {
    let caught
    try {
      await resolveTerminology('http://example.org/ConceptMap/r4-shaped|1', configWith())
    } catch (err) {
      caught = err
    }
    expect(caught.status).toBe(422)
    expect(caught.message).toContain('equivalence')
  })

  test('a canonical unknown as both a ValueSet and a ConceptMap is 404 naming the canonical', async () => {
    let caught
    try {
      await resolveTerminology('http://example.org/ConceptMap/missing|1', configWith())
    } catch (err) {
      caught = err
    }
    expect(caught.status).toBe(404)
    expect(caught.issues[0].code).toBe('not-found')
    expect(caught.message).toContain('http://example.org/ConceptMap/missing|1')
    expect(caught.message).toContain('ConceptMap')
  })

  test('a failed ConceptMap search is 422 with the server diagnostics', async () => {
    let caught
    try {
      await resolveTerminology('http://example.org/ConceptMap/broken', configWith())
    } catch (err) {
      caught = err
    }
    expect(caught.status).toBe(422)
    expect(caught.message).toContain('Simulated concept map search failure')
  })
})
