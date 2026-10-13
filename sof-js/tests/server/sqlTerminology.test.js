/**
 * HTTP-level tests for ValueSet and ConceptMap dependencies on `$sql-run`: a
 * `relatedArtifact[depends-on]` naming a ValueSet is exposed to the SQL as a
 * relation with the columns `system`, `version`, `code`, `display` and
 * `inactive`, and one naming a ConceptMap as a relation with one row per
 * mapping, populated from a supplied (`context`) artifact, a stored artifact or
 * a terminology server.
 *
 * Author: John Grimes
 */

import { startTestServer, parameters, post, sqlQueryLibrary } from './helpers.js'
import { SCT_TO_ICD10_ROWS, sctToIcd10Map } from './conceptMapFixtures.js'

let server
let base
let tx
const port = 3006

const GENDER_VS = 'http://hl7.org/fhir/ValueSet/administrative-gender'
const CVD_VS = 'http://myig.org/ValueSet/cardiovascular-disease'
const CONDITIONS = 'http://myig.org/ViewDefinition/conditions'
const SCT_TO_ICD10_CM = 'http://myig.org/ConceptMap/sct-to-icd10'

beforeAll(async () => {
  ;({ server, base, tx } = await startTestServer(port, { terminologyMaxMembers: 100 }, { pageSize: 2 }))
}, 120000)

afterAll(async () => {
  server?.close()
  await tx?.close()
})

beforeEach(() => {
  tx.requests.length = 0
})

// Run an inline SQLQuery Library through $sql-run, with optional inline
// `context` artifacts.
async function run(library, format = 'json', context = []) {
  return post(
    base,
    '/$sql-run',
    parameters([
      { name: 'subjectResource', resource: library },
      { name: '_format', valueCode: format },
      ...context.map((resource) => ({ name: 'context', resource })),
    ]),
  )
}

// Run a stored Library through $sql-run.
async function runStored(id, format = 'json') {
  return post(
    base,
    '/$sql-run',
    parameters([
      { name: 'subjectReference', valueReference: { reference: `Library/${id}` } },
      { name: '_format', valueCode: format },
    ]),
  )
}

// Build an inline SQLQuery Library from SQL text and [canonical, label] pairs.
function library(sql, deps) {
  return sqlQueryLibrary(
    sql,
    deps.map(([resource, label]) => ({ resource, label })),
  )
}

async function outcome(res) {
  const body = await res.json()
  expect(body.resourceType).toBe('OperationOutcome')
  return body
}

describe('ValueSet dependencies on $sql-run', () => {
  test('a stored ValueSet with an expansion is exposed as a relation with the five columns', async () => {
    const res = await run(library('SELECT * FROM cvd ORDER BY code', [[`${CVD_VS}|1.0.0`, 'cvd']]))
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBeGreaterThan(0)
    expect(Object.keys(rows[0])).toEqual(['system', 'version', 'code', 'display', 'inactive'])
    // Every member is a SNOMED CT code; the abstract grouping entry in the
    // stored expansion contributes no row.
    expect(rows.every((r) => r.system === 'http://snomed.info/sct')).toBe(true)
    expect(rows.some((r) => r.code === '59621000')).toBe(true)
    expect(rows.every((r) => r.display !== 'Cardiovascular disease')).toBe(true)
    // Rows are unique on (system, version, code).
    const keys = rows.map((r) => `${r.system}|${r.version}|${r.code}`)
    expect(new Set(keys).size).toBe(keys.length)
    // The stored resource resolved locally, so the terminology server was not used.
    expect(tx.requests).toHaveLength(0)
  })

  test('the shipped cardiovascular-patients Library returns exactly the patients with a member condition', async () => {
    const res = await runStored('cardiovascular-patients')
    expect(res.status).toBe(200)
    const patients = (await res.json()).map((r) => r.patient_id).sort()
    expect(patients.length).toBeGreaterThan(0)

    // Cross-check: compute the same set with an explicit IN list drawn from
    // the relation itself, so the semi-join is verified against plain SQL.
    const check = await run(
      library(
        `SELECT DISTINCT conditions.patient_id FROM conditions
         WHERE conditions.system = 'http://snomed.info/sct'
           AND conditions.code IN (SELECT code FROM cvd)`,
        [
          [CONDITIONS, 'conditions'],
          [`${CVD_VS}|1.0.0`, 'cvd'],
        ],
      ),
    )
    const expected = (await check.json()).map((r) => r.patient_id).sort()
    expect(patients).toEqual(expected)

    // And a patient with only non-member conditions is not returned.
    const nonMember = await run(
      library(
        `SELECT DISTINCT conditions.patient_id FROM conditions
         WHERE conditions.patient_id NOT IN (
           SELECT c2.patient_id FROM conditions c2
           WHERE EXISTS (SELECT 1 FROM cvd WHERE cvd.system = c2.system AND cvd.code = c2.code)
         )`,
        [
          [CONDITIONS, 'conditions'],
          [`${CVD_VS}|1.0.0`, 'cvd'],
        ],
      ),
    )
    const outsiders = (await nonMember.json()).map((r) => r.patient_id)
    expect(outsiders.length).toBeGreaterThan(0)
    expect(outsiders.some((id) => patients.includes(id))).toBe(false)
  })

  test('a ValueSet the server does not hold is expanded by the terminology server, paging to completion', async () => {
    const res = await run(
      library(
        `SELECT gender_codes.display, COUNT(*) AS patients
         FROM patient_demographics
         JOIN gender_codes ON gender_codes.code = patient_demographics.gender
         GROUP BY gender_codes.display ORDER BY gender_codes.display`,
        [
          ['http://myig.org/ViewDefinition/patient_demographics', 'patient_demographics'],
          [`${GENDER_VS}|5.0.0`, 'gender_codes'],
        ],
      ),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.map((r) => r.display)).toEqual(['Female', 'Male'])
    expect(rows.every((r) => r.patients > 0)).toBe(true)
    // Four members at a page size of two: two GETs with the pinned version.
    const expands = tx.requests.filter((r) => r.path === '/ValueSet/$expand')
    expect(expands.map((r) => r.method)).toEqual(['GET', 'GET'])
    expect(expands.every((r) => r.query.url === GENDER_VS && r.query.valueSetVersion === '5.0.0')).toBe(true)
  })

  test('two pinned versions of one value set in a query are distinct relations', async () => {
    // Version 3.0.0 of the mock's gender value set has two members; 5.0.0 has four.
    const res = await run(
      library('SELECT (SELECT COUNT(*) FROM old) AS old, (SELECT COUNT(*) FROM new) AS new', [
        [`${GENDER_VS}|3.0.0`, 'old'],
        [`${GENDER_VS}|5.0.0`, 'new'],
      ]),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ old: 2, new: 4 }])
  })

  test('an unpinned dependency is expanded without a valueSetVersion parameter', async () => {
    const res = await run(library('SELECT COUNT(*) AS n FROM g', [[GENDER_VS, 'g']]))
    expect(res.status).toBe(200)
    expect((await res.json())[0].n).toBe(4)
    expect(tx.requests[0].query.valueSetVersion).toBeUndefined()
  })

  test('the inactive column is a boolean, true for an inactive member and null otherwise', async () => {
    const res = await run(
      library('SELECT code, inactive FROM vs ORDER BY code', [
        ['http://example.org/ValueSet/with-inactive', 'vs'],
      ]),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { code: 'live', inactive: null },
      { code: 'retired', inactive: true },
    ])
  })

  test('_format=fhir carries the relation columns as strings and inactive as a boolean', async () => {
    const res = await run(
      library("SELECT * FROM vs WHERE code = 'retired'", [
        ['http://example.org/ValueSet/with-inactive', 'vs'],
      ]),
      'fhir',
    )
    expect(res.status).toBe(200)
    const params = await res.json()
    const parts = Object.fromEntries(params.parameter[0].part.map((p) => [p.name, p]))
    expect(parts.system.valueString).toBe('http://example.org/cs')
    expect(parts.code.valueString).toBe('retired')
    expect(parts.display.valueString).toBe('Retired')
    expect(parts.inactive.valueBoolean).toBe(true)
    // Null version is omitted rather than encoded.
    expect(parts.version).toBeUndefined()
  })

  test('a value set with no matching members yields an empty result, not an error', async () => {
    const res = await run(
      library("SELECT COUNT(*) AS n FROM cvd WHERE code = 'nope'", [[`${CVD_VS}|1.0.0`, 'cvd']]),
    )
    expect(res.status).toBe(200)
    expect((await res.json())[0].n).toBe(0)
  })

  test('a canonical neither stored nor known to the terminology server is rejected with 404', async () => {
    const res = await run(library('SELECT * FROM vs', [['http://example.org/ValueSet/missing|1', 'vs']]))
    expect(res.status).toBe(404)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-found')
    expect(body.issue[0].diagnostics).toContain('http://example.org/ValueSet/missing|1')
  })

  test('a terminology server failure is rejected with 422 before any SQL runs', async () => {
    const res = await run(
      library('SELECT * FROM does_not_exist_either', [['http://example.org/ValueSet/broken', 'vs']]),
    )
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('processing')
    // The SQL error about the missing table never appears: the request failed
    // on membership, as the specification requires.
    expect(body.issue[0].diagnostics).not.toContain('does_not_exist_either')
  })

  test('a depends-on entry with no resource is rejected as invalid, not treated as a value set', async () => {
    const lib = library('SELECT * FROM vs', [])
    lib.relatedArtifact.push({ type: 'depends-on', label: 'vs' })
    const res = await run(lib)
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].diagnostics).toContain("'resource'")
    expect(tx.requests).toHaveLength(0)
  })

  test('a value set reached from a stored SQLView and from the query is resolved once per job', async () => {
    // The stored gender-codes-view SQLView depends on the gender value set;
    // the query depends on the same value set directly as well as on the view.
    const res = await run(
      library('SELECT COUNT(*) AS n FROM g JOIN gv ON gv.code = g.code', [
        [`${GENDER_VS}|5.0.0`, 'g'],
        ['http://myig.org/Library/gender-codes-view', 'gv'],
      ]),
    )
    expect(res.status).toBe(200)
    expect((await res.json())[0].n).toBe(4)
    // Two GETs (two pages) in total: the second reference reused the first resolution.
    expect(tx.requests.filter((r) => r.path === '/ValueSet/$expand')).toHaveLength(2)
  })

  test('the shipped patients-by-gender Library joins display text from the terminology server', async () => {
    const res = await runStored('patients-by-gender')
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.map((r) => r.gender)).toEqual(['Female', 'Male'])
    expect(rows.every((r) => r.patients > 0)).toBe(true)
  })

  test('$validate does not warn about a stored ValueSet dependency', async () => {
    const res = await post(
      base,
      '/Library/$validate',
      library('SELECT * FROM cvd', [[`${CVD_VS}|1.0.0`, 'cvd']]),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const notFound = (body.issue || []).filter((i) => i.code === 'not-found')
    expect(notFound).toHaveLength(0)
  })
})

describe('ConceptMap dependencies on $sql-run', () => {
  // The translation query from the specification's worked example, over the
  // example's four conditions supplied as a CTE so the output can be compared
  // with the documented result.
  const SPEC_EXAMPLE_SQL = `WITH conditions (patient_id, system, version, code) AS (
  VALUES ('p1', 'http://snomed.info/sct', NULL, '22298006'),
         ('p2', 'http://hl7.org/fhir/sid/icd-10', NULL, 'I21'),
         ('p3', 'http://snomed.info/sct', NULL, '73211009'),
         ('p4', 'http://snomed.info/sct', NULL, '102499006')
)
SELECT conditions.patient_id, conditions.code, sct_to_icd10.target_code, sct_to_icd10.relationship
FROM conditions
LEFT JOIN sct_to_icd10
  ON sct_to_icd10.source_system = conditions.system
 AND sct_to_icd10.source_code = conditions.code
 AND (sct_to_icd10.relationship IS NULL OR sct_to_icd10.relationship <> 'not-related-to')
ORDER BY conditions.patient_id`

  const SPEC_MAP = 'http://example.org/ConceptMap/sct-to-icd10|2026'

  test('a supplied ConceptMap reproduces the specification worked example', async () => {
    const res = await run(library(SPEC_EXAMPLE_SQL, [[SPEC_MAP, 'sct_to_icd10']]), 'json', [sctToIcd10Map()])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { patient_id: 'p1', code: '22298006', target_code: 'I21', relationship: 'equivalent' },
      { patient_id: 'p2', code: 'I21', target_code: null, relationship: null },
      {
        patient_id: 'p3',
        code: '73211009',
        target_code: 'E14',
        relationship: 'source-is-broader-than-target',
      },
      { patient_id: 'p4', code: '102499006', target_code: null, relationship: null },
    ])
    // The supplied map was used as given; nothing was asked of the terminology server.
    expect(tx.requests).toHaveLength(0)
  })

  test('the relation of a supplied ConceptMap has the nine columns in order, one row per mapping', async () => {
    const res = await run(library('SELECT * FROM m', [[SPEC_MAP, 'm']]), 'json', [sctToIcd10Map()])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SCT_TO_ICD10_ROWS)
  })

  test('a stored ConceptMap is exposed as a relation without contacting the terminology server', async () => {
    const res = await run(
      library('SELECT source_code, target_code, relationship FROM m ORDER BY source_code', [
        [`${SCT_TO_ICD10_CM}|1.0.0`, 'm'],
      ]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows).toContainEqual({ source_code: '59621000', target_code: 'I10', relationship: 'equivalent' })
    // The stored map's noMap element is a row with a null target.
    expect(rows).toContainEqual({ source_code: '160903007', target_code: null, relationship: null })
    expect(tx.requests).toHaveLength(0)
  })

  test('a supplied ConceptMap takes precedence over a stored one with the same url', async () => {
    const supplied = { ...sctToIcd10Map(), url: SCT_TO_ICD10_CM, version: '1.0.0' }
    const res = await run(
      library('SELECT COUNT(*) AS n FROM m', [[`${SCT_TO_ICD10_CM}|1.0.0`, 'm']]),
      'json',
      [supplied],
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ n: SCT_TO_ICD10_ROWS.length }])
  })

  test('the shipped conditions-to-icd10 Library keeps every condition and translates mapped codes', async () => {
    const res = await runStored('conditions-to-icd10')
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Object.keys(rows[0])).toEqual(['patient_id', 'code', 'target_code', 'relationship'])

    // The LEFT JOIN keeps one row per condition: the map gives each source
    // code at most one target, so the count equals the conditions count.
    const count = await run(library('SELECT COUNT(*) AS n FROM c', [[CONDITIONS, 'c']]))
    expect(rows).toHaveLength((await count.json())[0].n)

    const hypertension = rows.filter((r) => r.code === '59621000')
    expect(hypertension.length).toBeGreaterThan(0)
    expect(hypertension.every((r) => r.target_code === 'I10' && r.relationship === 'equivalent')).toBe(true)
    // A noMap code and an unmapped code are both kept, with no target.
    const employment = rows.filter((r) => r.code === '160903007')
    expect(employment.length).toBeGreaterThan(0)
    expect(employment.every((r) => r.target_code === null)).toBe(true)
    expect(rows.some((r) => r.code === '73595000' && r.target_code === null)).toBe(true)
  })

  test('a ConceptMap the server does not hold is found on the terminology server', async () => {
    const res = await run(
      library('SELECT source_code, target_code FROM m', [['http://example.org/ConceptMap/remote|1', 'm']]),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ source_code: '59621000', target_code: 'I10' }])
    expect(tx.requests.map((r) => r.path)).toEqual(['/ValueSet/$expand', '/ConceptMap'])
  })

  test('a ConceptMap with a dependsOn target is rejected with 422 before any SQL runs', async () => {
    const map = sctToIcd10Map()
    map.group[0].element[0].target[0].dependsOn = [{ attribute: 'site', valueCode: 'left' }]
    const res = await run(library('SELECT * FROM does_not_exist', [[SPEC_MAP, 'm']]), 'json', [map])
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('processing')
    expect(body.issue[0].diagnostics).toContain('dependsOn')
    expect(body.issue[0].diagnostics).not.toContain('does_not_exist')
  })

  test('an R4-shaped ConceptMap from the terminology server is rejected with 422', async () => {
    const res = await run(library('SELECT * FROM m', [['http://example.org/ConceptMap/r4-shaped|1', 'm']]))
    expect(res.status).toBe(422)
    expect((await outcome(res)).issue[0].diagnostics).toContain('equivalence')
  })

  test('_format=fhir omits the null target columns of a noMap row', async () => {
    const res = await run(
      library("SELECT * FROM m WHERE source_code = '102499006'", [[SPEC_MAP, 'm']]),
      'fhir',
      [sctToIcd10Map()],
    )
    expect(res.status).toBe(200)
    const parts = (await res.json()).parameter[0].part.map((p) => p.name)
    expect(parts).toEqual([
      'source_system',
      'source_code',
      'source_display',
      'target_system',
      'target_version',
    ])
  })

  test('$validate does not warn about a stored ConceptMap dependency', async () => {
    const res = await post(
      base,
      '/Library/$validate',
      library('SELECT * FROM m', [[`${SCT_TO_ICD10_CM}|1.0.0`, 'm']]),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect((body.issue || []).filter((i) => i.code === 'not-found')).toHaveLength(0)
  })
})

describe('Supplied ValueSets on $sql-run', () => {
  // A ValueSet with the stored cardiovascular value set's url and version but
  // a single member, so the relation shows which one was used.
  function suppliedCvd(expansion) {
    return {
      resourceType: 'ValueSet',
      url: CVD_VS,
      version: '1.0.0',
      status: 'active',
      expansion: expansion ?? {
        total: 1,
        contains: [{ system: 'http://snomed.info/sct', code: '59621000', display: 'Hypertension' }],
      },
    }
  }

  test('a supplied expansion is used in place of the stored ValueSet with the same url', async () => {
    const res = await run(library('SELECT code FROM cvd', [[`${CVD_VS}|1.0.0`, 'cvd']]), 'json', [
      suppliedCvd(),
    ])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ code: '59621000' }])
    expect(tx.requests).toHaveLength(0)
  })

  test('a supplied incomplete expansion is rejected with 422', async () => {
    const incomplete = suppliedCvd({ total: 5, contains: [{ system: 'http://snomed.info/sct', code: '1' }] })
    const res = await run(library('SELECT * FROM cvd', [[`${CVD_VS}|1.0.0`, 'cvd']]), 'json', [incomplete])
    expect(res.status).toBe(422)
    expect((await outcome(res)).issue[0].code).toBe('processing')
  })

  test('a supplied compose-only ValueSet is expanded on the terminology server', async () => {
    const composeOnly = {
      resourceType: 'ValueSet',
      url: 'http://example.org/ValueSet/inline-compose',
      status: 'active',
      compose: { include: [{ system: 'http://example.org/cs', concept: [{ code: 'z', display: 'Z' }] }] },
    }
    const res = await run(
      library('SELECT code FROM vs', [['http://example.org/ValueSet/inline-compose', 'vs']]),
      'json',
      [composeOnly],
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ code: 'z' }])
    expect(tx.requests.map((r) => r.method)).toEqual(['POST'])
  })
})
