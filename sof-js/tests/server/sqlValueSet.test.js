/**
 * HTTP-level tests for ValueSet dependencies on `$sql-run`: a
 * `relatedArtifact[depends-on]` naming a ValueSet is exposed to the SQL as a
 * relation with the columns `system`, `version`, `code`, `display` and
 * `inactive`, populated from a stored ValueSet or a terminology server.
 *
 * Author: John Grimes
 */

import { startTestServer, parameters, post, sqlQueryLibrary } from './helpers.js'

let server
let base
let tx
const port = 3006

const GENDER_VS = 'http://hl7.org/fhir/ValueSet/administrative-gender'
const CVD_VS = 'http://myig.org/ValueSet/cardiovascular-disease'
const CONDITIONS = 'http://myig.org/ViewDefinition/conditions'

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

// Run an inline SQLQuery Library through $sql-run.
async function run(library, format = 'json') {
  return post(
    base,
    '/$sql-run',
    parameters([
      { name: 'subjectResource', resource: library },
      { name: '_format', valueCode: format },
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
          [`${GENDER_VS}|4.0.1`, 'gender_codes'],
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
    expect(expands.every((r) => r.query.url === GENDER_VS && r.query.valueSetVersion === '4.0.1')).toBe(true)
  })

  test('two pinned versions of one value set in a query are distinct relations', async () => {
    // Version 3.0.0 of the mock's gender value set has two members; 4.0.1 has four.
    const res = await run(
      library('SELECT (SELECT COUNT(*) FROM old) AS old, (SELECT COUNT(*) FROM new) AS new', [
        [`${GENDER_VS}|3.0.0`, 'old'],
        [`${GENDER_VS}|4.0.1`, 'new'],
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
        [`${GENDER_VS}|4.0.1`, 'g'],
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
