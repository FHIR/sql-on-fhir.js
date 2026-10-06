/**
 * HTTP-level tests for the `$sql-run` operation, following the contract on
 * OperationDefinition-SQLRun and Common Operation Behavior in the SQL on FHIR
 * specification.
 *
 * Author: John Grimes
 */

import {
  startTestServer,
  parameters,
  post,
  sqlQueryLibrary,
  sqlViewLibrary,
  patientView,
  KNOWN_PATIENTS,
} from './helpers.js'

let server
let base
let tx
const port = 3010

beforeAll(async () => {
  ;({ server, base, tx } = await startTestServer(port))
}, 120000)

afterAll(async () => {
  server?.close()
  await tx?.close()
})

const VIEW_CANONICAL = 'http://myig.org/ViewDefinition/patient_demographics'

async function get(query, headers = {}) {
  return fetch(`${base}/$sql-run?${query}`, { headers })
}

async function outcome(res) {
  const body = await res.json()
  expect(body.resourceType).toBe('OperationOutcome')
  return body
}

// ---------------------------------------------------------------------------
// Naming the subject
// ---------------------------------------------------------------------------

describe('$sql-run subject naming', () => {
  test('GET with subjectReference to a stored ViewDefinition returns rows', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&_format=json')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const rows = await res.json()
    expect(rows.length).toBeGreaterThan(0)
    expect(Object.keys(rows[0])).toEqual(['id', 'date_of_birth', 'gender'])
  })

  test('GET with subjectCanonical resolves by url', async () => {
    const res = await get(`subjectCanonical=${encodeURIComponent(VIEW_CANONICAL)}&_format=json`)
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBeGreaterThan(0)
  })

  test('subjectCanonical with a version suffix that does not match is 404', async () => {
    const res = await get(`subjectCanonical=${encodeURIComponent(VIEW_CANONICAL + '|9.9.9')}&_format=json`)
    expect(res.status).toBe(404)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-found')
    expect(body.issue[0].expression).toEqual(['subjectCanonical'])
  })

  test('unknown subjectReference is 404 naming the parameter', async () => {
    const res = await get('subjectReference=Library/does-not-exist')
    expect(res.status).toBe(404)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-found')
    expect(body.issue[0].expression).toEqual(['subjectReference'])
  })

  test('subjectReference as an absolute URL under the server base resolves', async () => {
    const res = await get(
      `subjectReference=${encodeURIComponent(base + '/ViewDefinition/patient_demographics')}&_format=json`,
    )
    expect(res.status).toBe(200)
  })

  test('no subject is 400 required', async () => {
    const res = await get('_format=json')
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('required')
    expect(body.issue[0].expression).toEqual(['subject'])
  })

  test('two subject forms is 400 invalid', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'ViewDefinition/patient_demographics' } },
        { name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['subject'])
  })

  test('a resolved artifact that is neither ViewDefinition, SQLQuery nor SQLView is 422', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        {
          name: 'subjectResource',
          resource: {
            resourceType: 'Library',
            status: 'active',
            type: { coding: [{ code: 'logic-library' }] },
          },
        },
      ]),
    )
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['subjectResource'])
  })

  test('a SQL syntax error in a conformant subject is 422', async () => {
    const lib = sqlQueryLibrary('SELEC nonsense FROM p', [{ resource: VIEW_CANONICAL, label: 'p' }])
    const res = await post(base, '/$sql-run', parameters([{ name: 'subjectResource', resource: lib }]))
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
  })
})

// ---------------------------------------------------------------------------
// Formats and content negotiation
// ---------------------------------------------------------------------------

describe('$sql-run output formats', () => {
  test('defaults to ndjson when neither _format nor Accept selects a format', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson')
    const lines = (await res.text()).trim().split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(JSON.parse(lines[0])).toHaveProperty('id')
  })

  test('Accept selects the format when _format is absent', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics', { Accept: 'text/csv' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    const [header] = (await res.text()).split('\n')
    expect(header).toBe('id,date_of_birth,gender')
  })

  test('_format takes precedence over Accept', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&_format=json', {
      Accept: 'text/csv',
    })
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test('csv with header=false omits the header row', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&_format=csv&header=false')
    const [first] = (await res.text()).split('\n')
    expect(first).not.toBe('id,date_of_birth,gender')
  })

  test('Accept application/fhir+json wraps a flat format in a Binary envelope', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&_format=csv', {
      Accept: 'application/fhir+json',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/fhir+json')
    const binary = await res.json()
    expect(binary.resourceType).toBe('Binary')
    expect(binary.contentType).toBe('text/csv')
    const csv = Buffer.from(binary.data, 'base64').toString('utf8')
    expect(csv.split('\n')[0]).toBe('id,date_of_birth,gender')
  })

  test('Accept application/fhir+xml is 406 on a JSON-only server', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&_format=csv', {
      Accept: 'application/fhir+xml',
    })
    expect(res.status).toBe(406)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-supported')
  })

  test('unsupported format parquet is 400 not-supported', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&_format=parquet')
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-supported')
    expect(body.issue[0].expression).toEqual(['_format'])
  })

  test('_format=fhir returns a Parameters resource with typed row parts', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'Library/patient-count' } },
        { name: '_format', valueCode: 'fhir' },
      ]),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/fhir+json')
    const body = await res.json()
    expect(body.resourceType).toBe('Parameters')
    expect(body.parameter.length).toBe(1)
    expect(body.parameter[0].name).toBe('row')
    expect(body.parameter[0].part[0].name).toBe('total')
    expect(typeof body.parameter[0].part[0].valueInteger).toBe('number')
  })

  test('_format=fhir re-types a SQL column that reuses a view column name for another type', async () => {
    const lib = sqlQueryLibrary('SELECT COUNT(*) AS gender FROM p', [
      { resource: VIEW_CANONICAL, label: 'p' },
    ])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: '_format', valueCode: 'fhir' },
      ]),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.parameter[0].part[0]).toEqual({ name: 'gender', valueInteger: expect.any(Number) })
  })

  test('numbers and booleans survive materialisation through a SQLView', async () => {
    const births = 'http://myig.org/ViewDefinition/patient_multiple_birth'
    const viewUrl = 'https://example.org/Library/births_with_n'
    const sqlView = sqlViewLibrary(viewUrl, 'SELECT id, multiple_birth, 42 AS n FROM p', [
      { resource: births, label: 'p' },
    ])
    const lib = sqlQueryLibrary(
      'SELECT id, multiple_birth, typeof(n) AS t, n FROM v WHERE multiple_birth = 0 LIMIT 1',
      [{ resource: viewUrl, label: 'v' }],
    )
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: sqlView },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(res.status).toBe(200)
    const [row] = await res.json()
    expect(row).toMatchObject({ multiple_birth: false, t: 'integer', n: 42 })
  })

  test('an untyped numeric column keeps its number type and sorts numerically', async () => {
    const view = {
      resourceType: 'ViewDefinition',
      url: 'https://example.org/ViewDefinition/untyped_values',
      status: 'active',
      resource: 'Observation',
      select: [{ column: [{ name: 'v', path: 'value.ofType(Quantity).value' }] }],
    }
    const lib = sqlQueryLibrary('SELECT v, typeof(v) AS t FROM o WHERE v IS NOT NULL ORDER BY v LIMIT 3', [
      { resource: view.url, label: 'o' },
    ])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: view },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(typeof r.v).toBe('number')
      expect(['integer', 'real']).toContain(r.t)
    }
    expect(rows[0].v).toBeLessThanOrEqual(rows[1].v)
    expect(rows[1].v).toBeLessThanOrEqual(rows[2].v)
  })

  test('a boolean-named column reused for text is not coerced to a boolean', async () => {
    const lib = sqlQueryLibrary(
      "SELECT id, CASE WHEN multiple_birth THEN 'yes' ELSE 'no' END AS multiple_birth FROM p LIMIT 2",
      [{ resource: 'http://myig.org/ViewDefinition/patient_multiple_birth', label: 'p' }],
    )
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    for (const r of rows) expect(['yes', 'no']).toContain(r.multiple_birth)
  })

  test('_format=fhir keeps the text of a CASE expression under a boolean-named column', async () => {
    const lib = sqlQueryLibrary(
      "SELECT CASE WHEN multiple_birth THEN 'yes' ELSE 'no' END AS multiple_birth FROM p WHERE multiple_birth = 0 LIMIT 1",
      [{ resource: 'http://myig.org/ViewDefinition/patient_multiple_birth', label: 'p' }],
    )
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: '_format', valueCode: 'fhir' },
      ]),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.parameter[0].part[0].valueString).toBe('no')
  })

  test('_format=fhir types a declared date column as valueDate', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'ViewDefinition/patient_demographics' } },
        { name: '_format', valueCode: 'fhir' },
        { name: '_limit', valueInteger: 1 },
      ]),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const part = body.parameter[0].part
    expect(part.find((p) => p.name === 'date_of_birth').valueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('a computed number under a boolean-named column is left alone in every format', async () => {
    const sql = 'SELECT COUNT(*) AS multiple_birth FROM p'
    const lib = sqlQueryLibrary(sql, [
      { resource: 'http://myig.org/ViewDefinition/patient_multiple_birth', label: 'p' },
    ])
    for (const format of ['json', 'fhir']) {
      const res = await post(
        base,
        '/$sql-run',
        parameters([
          { name: 'subjectResource', resource: lib },
          { name: '_format', valueCode: format },
        ]),
      )
      expect(res.status).toBe(200)
      if (format === 'json') {
        const rows = await res.json()
        expect(rows[0].multiple_birth).toBeGreaterThan(1)
      } else {
        const body = await res.json()
        expect(body.parameter[0].part[0].valueInteger).toBeGreaterThan(1)
      }
    }
  })

  test('a binary result column is encoded as valueBase64Binary and base64 in flat formats', async () => {
    const lib = sqlQueryLibrary("SELECT id, x'00ff' AS blob FROM p LIMIT 1", [
      { resource: VIEW_CANONICAL, label: 'p' },
    ])
    const fhir = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: '_format', valueCode: 'fhir' },
      ]),
    )
    expect(fhir.status).toBe(200)
    const body = await fhir.json()
    expect(body.parameter[0].part.find((p) => p.name === 'blob').valueBase64Binary).toBe(
      Buffer.from([0, 255]).toString('base64'),
    )

    lib.content[0].extension[0].valueString = "SELECT id, x'00ff' AS blob FROM p LIMIT 1"
    lib.content[0].data = Buffer.from(lib.content[0].extension[0].valueString).toString('base64')
    const json = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(json.status).toBe(200)
    const row = (await json.json())[0]
    expect(row.blob).toBe(Buffer.from([0, 255]).toString('base64'))
  })

  test('two dependencies sharing a label are 422, not a 500', async () => {
    const lib = sqlQueryLibrary('SELECT 1 AS n FROM p', [
      { resource: VIEW_CANONICAL, label: 'p' },
      { resource: 'http://myig.org/ViewDefinition/observations', label: 'p' },
    ])
    const res = await post(base, '/$sql-run', parameters([{ name: 'subjectResource', resource: lib }]))
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['subjectResource'])
  })

  test('a unionAll view yields one column set in csv and as a SQL dependency', async () => {
    const unionView = {
      resourceType: 'ViewDefinition',
      url: 'https://example.org/ViewDefinition/union_names',
      status: 'active',
      resource: 'Patient',
      select: [
        { column: [{ name: 'id', path: 'getResourceKey()', type: 'id' }] },
        {
          unionAll: [
            { forEach: 'name', column: [{ name: 'family', path: 'family', type: 'string' }] },
            { forEach: 'contact.name', column: [{ name: 'family', path: 'family', type: 'string' }] },
          ],
        },
      ],
    }
    const csv = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: unionView },
        { name: '_format', valueCode: 'csv' },
        { name: '_limit', valueInteger: 1 },
      ]),
    )
    expect(csv.status).toBe(200)
    const [header, row] = (await csv.text()).trimEnd().split('\n')
    expect(header).toBe('id,family')
    expect(row.split(',')).toHaveLength(2)

    const lib = sqlQueryLibrary('SELECT COUNT(DISTINCT family) AS n FROM u', [
      { resource: unionView.url, label: 'u' },
    ])
    const sql = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: unionView },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(sql.status).toBe(200)
    expect((await sql.json())[0].n).toBeGreaterThan(0)
  })

  test('_format=fhir with zero rows returns Parameters with no parameter element', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'Library/empty-result-view' } },
        { name: '_format', valueCode: 'fhir' },
      ]),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ resourceType: 'Parameters' })
  })

  test('_limit caps the rows returned', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&_format=json&_limit=3')
    const rows = await res.json()
    expect(rows.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Conditional parameters: resource, parameters, context
// ---------------------------------------------------------------------------

describe('$sql-run conditional parameters', () => {
  test('inline ViewDefinition over inline resources, with a Bundle unwrapped', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: patientView() },
        { name: 'resource', resource: { resourceType: 'Patient', id: 'pt-1', gender: 'female' } },
        {
          name: 'resource',
          resource: {
            resourceType: 'Bundle',
            type: 'collection',
            entry: [
              { resource: { resourceType: 'Patient', id: 'pt-2', gender: 'male' } },
              { resource: { resourceType: 'Observation', id: 'obs-1', status: 'final' } },
            ],
          },
        },
        { name: '_format', valueCode: 'csv' },
      ]),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.trimEnd().split('\n')).toEqual(['id,gender,birth_date', 'pt-1,female,', 'pt-2,male,'])
  })

  test('resource with a SQL subject is 400 invalid naming resource', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'Library/patient-count' } },
        { name: 'resource', resource: { resourceType: 'Patient', id: 'x' } },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['resource'])
  })

  test('parameters with a ViewDefinition subject is 400 invalid naming parameters', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'ViewDefinition/patient_demographics' } },
        { name: 'parameters', resource: parameters([{ name: 'x', valueString: 'y' }]) },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].expression).toEqual(['parameters'])
  })

  test('parameters bind by name to a stored SQLQuery', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'Library/patient-by-id' } },
        {
          name: 'parameters',
          resource: parameters([{ name: 'patient_id', valueString: KNOWN_PATIENTS[0] }]),
        },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(KNOWN_PATIENTS[0])
  })

  test('a parameter value of the wrong type is 400 invalid naming parameters', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'Library/patient-by-id' } },
        { name: 'parameters', resource: parameters([{ name: 'patient_id', valueInteger: 1 }]) },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['parameters'])
  })

  test('fully ad-hoc: inline SQLQuery with its ViewDefinition supplied as context', async () => {
    const viewUrl = 'https://example.org/ViewDefinition/adhoc_patients'
    const lib = sqlQueryLibrary('SELECT COUNT(*) AS n FROM p', [{ resource: viewUrl, label: 'p' }])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: patientView(viewUrl) },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows[0].n).toBeGreaterThan(0)
  })

  test('a context entry takes precedence over a stored artifact with the same url', async () => {
    // The stored patient_demographics view has no `gender_upper` column; the
    // supplied one does, so the query only succeeds if the supplied entry wins.
    const override = {
      resourceType: 'ViewDefinition',
      url: VIEW_CANONICAL,
      status: 'active',
      resource: 'Patient',
      select: [{ column: [{ name: 'gender_upper', path: 'gender.upper()', type: 'string' }] }],
    }
    const lib = sqlQueryLibrary('SELECT DISTINCT gender_upper FROM p', [
      { resource: VIEW_CANONICAL, label: 'p' },
    ])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: override },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.map((r) => r.gender_upper).sort()).toEqual(['FEMALE', 'MALE'])
  })

  test('context is matched transitively through a supplied SQLView', async () => {
    const viewUrl = 'https://example.org/ViewDefinition/transitive_patients'
    const sqlViewUrl = 'https://example.org/Library/transitive_females'
    const lib = sqlQueryLibrary('SELECT COUNT(*) AS n FROM f', [{ resource: sqlViewUrl, label: 'f' }])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        {
          name: 'context',
          resource: sqlViewLibrary(sqlViewUrl, "SELECT id FROM p WHERE gender = 'female'", [
            { resource: viewUrl, label: 'p' },
          ]),
        },
        { name: 'context', resource: patientView(viewUrl) },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows[0].n).toBeGreaterThan(0)
  })

  test('an unmatched context entry is 400 invalid naming context', async () => {
    const lib = sqlQueryLibrary('SELECT COUNT(*) AS n FROM p', [{ resource: VIEW_CANONICAL, label: 'p' }])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: patientView('https://example.org/ViewDefinition/typo') },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['context'])
    expect(body.issue[0].diagnostics).toContain('https://example.org/ViewDefinition/typo')
  })

  test("the spec's worked example: a typo in context beats the dependency 404", async () => {
    // The dependency is not on the server either; the mistake is still reported
    // where it was made, as 400 naming context, with the 404 alongside.
    const lib = sqlQueryLibrary('SELECT COUNT(*) AS n FROM p', [
      { resource: 'https://example.org/ViewDefinition/patient_view', label: 'p' },
    ])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: patientView('https://example.org/ViewDefinition/patient_veiw') },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['context'])
    expect(body.issue.map((i) => i.code)).toEqual(['invalid', 'not-found'])
  })

  test('a context entry with no url is 400 invalid', async () => {
    const lib = sqlQueryLibrary('SELECT 1 AS n FROM p', [{ resource: VIEW_CANONICAL, label: 'p' }])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: patientView() },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].expression).toEqual(['context'])
  })

  test('two context entries sharing a url is 400 invalid', async () => {
    const viewUrl = 'https://example.org/ViewDefinition/dup'
    const lib = sqlQueryLibrary('SELECT 1 AS n FROM p', [{ resource: viewUrl, label: 'p' }])
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: lib },
        { name: 'context', resource: patientView(viewUrl) },
        { name: 'context', resource: patientView(viewUrl) },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].expression).toEqual(['context'])
  })

  test('context with a ViewDefinition subject is 400 because nothing can match it', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'ViewDefinition/patient_demographics' } },
        { name: 'context', resource: patientView('https://example.org/ViewDefinition/x') },
      ]),
    )
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].expression).toEqual(['context'])
  })

  test('a dependency neither supplied nor resolvable is 404', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([{ name: 'subjectReference', valueReference: { reference: 'Library/ghost-dep-query' } }]),
    )
    expect(res.status).toBe(404)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-found')
  })
})

// ---------------------------------------------------------------------------
// Method and parameter support
// ---------------------------------------------------------------------------

describe('$sql-run request validation', () => {
  test('an unsupported parameter (source) is 400 not-supported naming it', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&source=s3://bucket')
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-supported')
    expect(body.issue[0].expression).toEqual(['source'])
  })

  test('a resource-carrying parameter over GET is 400 invalid naming it', async () => {
    const res = await get(`subjectResource=${encodeURIComponent(JSON.stringify(patientView()))}&_format=json`)
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['subjectResource'])
  })

  test('a POST body that is not a Parameters resource is 400', async () => {
    const res = await post(base, '/$sql-run', { resourceType: 'Patient' })
    expect(res.status).toBe(400)
    await outcome(res)
  })
})

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('$sql-run filtering', () => {
  test('patient restricts a Patient view to the named patient', async () => {
    const res = await get(
      `subjectReference=ViewDefinition/patient_demographics&patient=Patient/${KNOWN_PATIENTS[0]}&_format=json`,
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.map((r) => r.id)).toEqual([KNOWN_PATIENTS[0]])
  })

  test('patient repeats to name several patients', async () => {
    const res = await get(
      `subjectReference=ViewDefinition/patient_demographics&patient=Patient/${KNOWN_PATIENTS[0]}&patient=Patient/${KNOWN_PATIENTS[1]}&_format=json`,
    )
    const rows = await res.json()
    expect(rows.map((r) => r.id).sort()).toEqual([...KNOWN_PATIENTS].sort())
  })

  test('patient restricts an Observation view through the compartment', async () => {
    const res = await get(
      `subjectReference=ViewDefinition/observations&patient=Patient/${KNOWN_PATIENTS[0]}&_format=json`,
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBeGreaterThan(0)
    expect(new Set(rows.map((r) => r.subject))).toEqual(new Set([KNOWN_PATIENTS[0]]))
  })

  test('patient narrows the tables a SQL subject reads from', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectReference', valueReference: { reference: 'Library/patient-count' } },
        { name: 'patient', valueReference: { reference: `Patient/${KNOWN_PATIENTS[0]}` } },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    const rows = await res.json()
    expect(rows[0].total).toBe(1)
  })

  test('an unknown patient is 400 not-found naming patient', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&patient=Patient/nope')
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-found')
    expect(body.issue[0].expression).toEqual(['patient'])
  })

  test('group restricts to the members of the Group', async () => {
    const res = await get(
      'subjectReference=ViewDefinition/patient_demographics&group=Group/synthea-two-patients&_format=json',
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.map((r) => r.id).sort()).toEqual([...KNOWN_PATIENTS].sort())
  })

  test('an empty group yields no rows', async () => {
    const res = await get(
      'subjectReference=ViewDefinition/patient_demographics&group=Group/empty-group&_format=json',
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('an unknown group is 400 not-found naming group', async () => {
    const res = await get('subjectReference=ViewDefinition/patient_demographics&group=Group/nope')
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-found')
    expect(body.issue[0].expression).toEqual(['group'])
  })

  test('_since keeps resources updated after the instant and those without lastUpdated', async () => {
    const res = await post(
      base,
      '/$sql-run',
      parameters([
        { name: 'subjectResource', resource: patientView() },
        {
          name: 'resource',
          resource: { resourceType: 'Patient', id: 'old', meta: { lastUpdated: '2020-01-01T00:00:00Z' } },
        },
        {
          name: 'resource',
          resource: { resourceType: 'Patient', id: 'new', meta: { lastUpdated: '2026-01-01T00:00:00Z' } },
        },
        { name: 'resource', resource: { resourceType: 'Patient', id: 'undated' } },
        { name: '_since', valueInstant: '2025-01-01T00:00:00Z' },
        { name: '_format', valueCode: 'json' },
      ]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.map((r) => r.id).sort()).toEqual(['new', 'undated'])
  })

  test('an unresolvable subject and an unresolvable patient yield 404 reporting both', async () => {
    const res = await get('subjectReference=ViewDefinition/nope&patient=Patient/nope')
    expect(res.status).toBe(404)
    const body = await outcome(res)
    expect(body.issue).toHaveLength(2)
    expect(body.issue.map((i) => i.expression[0]).sort()).toEqual(['patient', 'subjectReference'])
  })
})
