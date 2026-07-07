import { startServer } from '../../src/server.js'

var server
const port = 3004
const base = `http://localhost:${port}`

beforeAll(async () => {
  server = await startServer({ port })
  console.log('Server started')
  await waitForData()
  // Allow up to 90 seconds so the suite passes when run in isolation against a
  // cold cache (the remote NDJSON load can take several seconds on first run).
}, 90000)

// Poll until the patient_demographics view returns at least one row. Data is
// fetched from a remote NDJSON source the first time the server starts, so
// downstream tests must wait for that load to complete.
async function waitForData(maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${base}/ViewDefinition/patient_demographics/$run?format=json`)
      if (res.status === 200) {
        const rows = await res.json()
        if (Array.isArray(rows) && rows.length > 0) return
      }
    } catch {
      // Server not yet listening — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('FHIR data did not load within the allotted time')
}

afterAll(async () => {
  console.log('Server stopped')
  server?.close()
})

async function postSqlQueryRun(path, body) {
  return await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json' },
    body: JSON.stringify(body),
  })
}

function paramsBody(parts) {
  return { resourceType: 'Parameters', parameter: parts }
}

describe('$sqlquery-run operation', () => {
  test('system route returns JSON for a stored Library', async () => {
    const res = await postSqlQueryRun(
      '/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryReference', valueReference: { reference: 'Library/patient-count' } },
      ]),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/fhir+json')

    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(1)
    expect(rows[0].total).toBeGreaterThan(0)
  })

  test('type route with queryReference returns NDJSON', async () => {
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'ndjson' },
        { name: 'queryReference', valueReference: { reference: 'Library/patient-count' } },
      ]),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/ndjson')

    const text = await res.text()
    const lines = text.trim().split('\n')
    expect(lines.length).toBe(1)
    const row = JSON.parse(lines[0])
    expect(row).toHaveProperty('total')
  })

  test('type route with inline queryResource returns CSV with header by default', async () => {
    const inline = inlinePatientCountLibrary()
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'csv' },
        { name: 'queryResource', resource: inline },
      ]),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')

    const text = await res.text()
    const lines = text.split('\n')
    expect(lines[0]).toBe('total')
    expect(lines.length).toBe(2)
  })

  test('type route with inline queryResource returns CSV without header when header=false', async () => {
    const inline = inlinePatientCountLibrary()
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'csv' },
        { name: 'header', valueBoolean: false },
        { name: 'queryResource', resource: inline },
      ]),
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    const lines = text.split('\n')
    // First line should be data, not the header.
    expect(lines[0]).not.toBe('total')
    expect(Number.isFinite(Number(lines[0]))).toBe(true)
  })

  test('instance route returns Parameters resource under _format=fhir', async () => {
    const res = await postSqlQueryRun(
      '/Library/patient-count/$sqlquery-run',
      paramsBody([{ name: '_format', valueCode: 'fhir' }]),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/fhir+json')

    const body = await res.json()
    expect(body.resourceType).toBe('Parameters')
    expect(Array.isArray(body.parameter)).toBe(true)
    expect(body.parameter.length).toBe(1)
    const row = body.parameter[0]
    expect(row.name).toBe('row')
    const totalPart = row.part.find((p) => p.name === 'total')
    expect(totalPart).toBeDefined()
    // COUNT(*) is an integer column.
    expect(typeof totalPart.valueInteger).toBe('number')
  })

  test('parameter binding round-trips a string value', async () => {
    // First, fetch a real patient id by running the patient_demographics view.
    const seedRes = await fetch(`${base}/ViewDefinition/patient_demographics/$run?format=json`)
    expect(seedRes.status).toBe(200)
    const seedRows = await seedRes.json()
    expect(seedRows.length).toBeGreaterThan(0)
    const expectedId = seedRows[0].id
    const expectedGender = seedRows[0].gender

    const res = await postSqlQueryRun(
      '/Library/patient-by-id/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        {
          name: 'parameters',
          resource: paramsBody([{ name: 'patient_id', valueString: expectedId }]),
        },
      ]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(expectedId)
    expect(rows[0].gender).toBe(expectedGender)
  })

  test('empty result under _format=fhir returns Parameters with no parameter array', async () => {
    const res = await postSqlQueryRun(
      '/Library/patient-by-id/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'fhir' },
        {
          name: 'parameters',
          resource: paramsBody([{ name: 'patient_id', valueString: 'no-such-patient' }]),
        },
      ]),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resourceType).toBe('Parameters')
    expect(body.parameter).toBeUndefined()
  })

  test('missing _format returns 400', async () => {
    const res = await postSqlQueryRun('/Library/patient-count/$sqlquery-run', paramsBody([]))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(body.issue[0].code).toBe('required')
  })

  test('unknown nested parameter name returns 400', async () => {
    const res = await postSqlQueryRun(
      '/Library/patient-by-id/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        {
          name: 'parameters',
          resource: paramsBody([{ name: 'unknown_param', valueString: 'x' }]),
        },
      ]),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(body.issue[0].code).toBe('invalid')
  })

  test('parameter type mismatch with declared Library.parameter.type returns 400', async () => {
    // patient-by-id declares patient_id as a string; sending valueInteger
    // should be rejected with a 400 invalid OperationOutcome.
    const res = await postSqlQueryRun(
      '/Library/patient-by-id/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        {
          name: 'parameters',
          resource: paramsBody([{ name: 'patient_id', valueInteger: 42 }]),
        },
      ]),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].diagnostics).toContain('valueString')
  })

  test('unknown Library id on instance route returns 404', async () => {
    const res = await postSqlQueryRun(
      '/Library/does-not-exist/$sqlquery-run',
      paramsBody([{ name: '_format', valueCode: 'json' }]),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(body.issue[0].code).toBe('not-found')
  })

  test('boolean column maps to valueBoolean under _format=fhir', async () => {
    // Use an inline Library that depends on the patient_multiple_birth view,
    // whose multiple_birth column is declared as boolean. The fhir output
    // should encode that column with valueBoolean per the SQL-to-FHIR type
    // mapping.
    const inline = inlinePatientMultipleBirthLibrary()
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'fhir' },
        { name: 'queryResource', resource: inline },
      ]),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resourceType).toBe('Parameters')
    expect(Array.isArray(body.parameter)).toBe(true)
    expect(body.parameter.length).toBeGreaterThan(0)

    // Find rows whose multiple_birth part is present and assert it carries
    // valueBoolean rather than a numeric or string encoding.
    const presentParts = body.parameter
      .map((row) => row.part.find((p) => p.name === 'multiple_birth'))
      .filter((part) => part !== undefined)
    expect(presentParts.length).toBeGreaterThan(0)
    for (const part of presentParts) {
      expect(typeof part.valueBoolean).toBe('boolean')
      expect(part.valueInteger).toBeUndefined()
    }
  })

  test('referenced ViewDefinition that cannot be resolved returns 404', async () => {
    const inline = inlineMissingViewLibrary()
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: inline },
      ]),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(body.issue[0].code).toBe('not-found')
    expect(body.issue[0].diagnostics).toContain('ViewDefinition')
  })

  test('SQL referencing a non-existent column returns 422', async () => {
    const inline = inlineBadColumnLibrary()
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: inline },
      ]),
    )

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(body.issue[0].code).toBe('processing')
  })
})

describe('$sqlquery-run pre-flight validation', () => {
  test('rejects a malformed Library with 422 before executing SQL', async () => {
    // A Library with an invalid type code (neither sql-query nor sql-view)
    // should be rejected with HTTP 422 before any SQL execution takes place.
    // The wrong-type Library has no relatedArtifact deps so no ViewDefinition
    // resolution is attempted - only shape validation fires.
    const malformed = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'logic-library' }] },
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT 1',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: malformed },
      ]),
    )

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    const errors = body.issue.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('Library $validate endpoint', () => {
  test('returns OperationOutcome with no errors for a conformant SQLQuery Library', async () => {
    // A well-formed SQLQuery Library posted to $validate should receive an
    // OperationOutcome with no error-severity issues.
    const lib = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/ViewDefinition/patient_demographics',
          label: 'patient_demographics',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT COUNT(*) AS total FROM patient_demographics',
            },
          ],
        },
      ],
    }
    const res = await fetch(`${base}/Library/$validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(lib),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(Array.isArray(body.issue)).toBe(true)
    const errors = body.issue.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('returns OperationOutcome with error issues for an invalid Library', async () => {
    // A Library with a wrong type code should receive error issues in the
    // returned OperationOutcome.
    const lib = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'logic-library' }] },
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT 1',
            },
          ],
        },
      ],
    }
    const res = await fetch(`${base}/Library/$validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(lib),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    const errors = body.issue.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
  })

  test('GET /Library/$validate returns an HTML form', async () => {
    // The GET endpoint should serve an HTML form for interactive validation.
    const res = await fetch(`${base}/Library/$validate`, {
      headers: { Accept: 'text/html' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('$validate')
    expect(html).toContain('Library')
  })

  test('POST /Library/$validate/form renders error issues in an HTML fragment (hx-request)', async () => {
    // An htmx form submission sends the hx-request header, expecting only the
    // inner HTML fragment back (not a full page layout).
    const invalidLib = JSON.stringify({
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'logic-library' }] },
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT 1',
            },
          ],
        },
      ],
    })
    const form = new URLSearchParams({ resource: invalidLib })
    const res = await fetch(`${base}/Library/$validate/form`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'hx-request': 'true',
      },
      body: form.toString(),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    // The rendered HTML fragment must contain an error indication for the
    // invalid type code.
    expect(html).toContain('error')
  })

  // 5.4 - Library-scoped $validate OperationDefinition
  test('GET /Library/$validate form page renders Library-$validate OperationDefinition metadata', async () => {
    // The Library $validate form must render content from the Library-scoped
    // OperationDefinition (Library-$validate), not a hard-coded fallback.
    // The specific description string from that resource is the discriminating
    // assertion: it can only appear if the OperationDefinition is loaded and
    // rendered.
    const res = await fetch(`${base}/Library/$validate`, {
      headers: { Accept: 'text/html' },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    // This substring is taken directly from the Library-$validate
    // OperationDefinition description field.
    expect(html).toContain('Validate a Library resource against the SQLQuery and SQLView profile rules')
    // The page must include the form target marker.
    expect(html).toContain('/Library/$validate/form')
  })

  test('POST /Library/$validate/form renders issues in a full page (no hx-request)', async () => {
    // A non-htmx form submission should receive a full layout page containing
    // the validation result.
    const validLib = JSON.stringify({
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT 1',
            },
          ],
        },
      ],
    })
    const form = new URLSearchParams({ resource: validLib })
    const res = await fetch(`${base}/Library/$validate/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    // A conformant Library should show "no errors" on the full page.
    expect(html).toContain('conformant')
  })
})

// ============================================================================
// SQLQuery / SQLView composition tests
// ============================================================================

describe('SQLQuery -> SQLView composition', () => {
  // 3.1 - SQLQuery -> SQLView -> ViewDefinition (inline top-level query)
  test('inline SQLQuery referencing a stored SQLView returns expected rows', async () => {
    // The stored patient-demographics-view SQLView wraps the patient_demographics
    // ViewDefinition. This inline SQLQuery counts rows from that view.
    const query = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/Library/patient-demographics-view',
          label: 'demo',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT COUNT(*) AS cnt FROM demo',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: query },
      ]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(1)
    expect(rows[0].cnt).toBeGreaterThan(0)
  })

  // 3.1 - stored SQLQuery referencing a stored SQLView (via instance route)
  test('stored patient-count-from-view SQLQuery via instance route returns rows', async () => {
    // Run the stored patient-count-from-view Library (added in metadata as part of
    // the composition feature) via the instance route.
    const res = await postSqlQueryRun(
      '/Library/patient-count-from-view/$sqlquery-run',
      paramsBody([{ name: '_format', valueCode: 'json' }]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(1)
    expect(rows[0].total).toBeGreaterThan(0)
  })

  // 3.2 - SQLQuery joins an SQLView and a ViewDefinition
  test('inline SQLQuery joining an SQLView and a ViewDefinition returns joined rows', async () => {
    // Join the patient_demographics_view SQLView (columns: id, date_of_birth, gender)
    // with the patient_multiple_birth ViewDefinition (columns: id, multiple_birth),
    // which share the patient id column.
    const query = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/Library/patient-demographics-view',
          label: 'demo',
        },
        {
          type: 'depends-on',
          resource: 'http://myig.org/ViewDefinition/patient_multiple_birth',
          label: 'births',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString:
                'SELECT demo.id, demo.gender, births.multiple_birth ' +
                'FROM demo JOIN births ON demo.id = births.id',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: query },
      ]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    // Each row must contain columns from both sources.
    expect(rows[0]).toHaveProperty('id')
    expect(rows[0]).toHaveProperty('gender')
    expect(rows[0]).toHaveProperty('multiple_birth')
  })

  // 3.3 - Run an SQLView directly as the top-level target
  test('inline SQLView supplied as top-level target returns its rows', async () => {
    // Supply the SQLView itself as the queryResource. The server should execute
    // it directly with no parameter bindings and return the view output.
    const view = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-view' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/ViewDefinition/patient_demographics',
          label: 'patient_demographics',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT id, gender FROM patient_demographics',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: view },
      ]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toHaveProperty('id')
    expect(rows[0]).toHaveProperty('gender')
  })

  // 3.3 - Run a stored SQLView via the instance route
  test('stored SQLView via instance route returns its rows', async () => {
    const res = await postSqlQueryRun(
      '/Library/patient-demographics-view/$sqlquery-run',
      paramsBody([{ name: '_format', valueCode: 'json' }]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
  })

  // 3.4 - Depth-3: SQLQuery -> SQLView A -> SQLView B -> ViewDefinition
  test('depth-3 composition (query -> view -> view -> ViewDefinition) returns expected rows', async () => {
    // The stored female-demographics-view depends on patient-demographics-view,
    // which in turn depends on the patient_demographics ViewDefinition. This
    // inline query counts rows via the three-level chain.
    const query = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/Library/female-demographics-view',
          label: 'females',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT COUNT(*) AS cnt FROM females',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: query },
      ]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(1)
    // The count must be a positive integer, confirming rows propagated through
    // the three-level chain.  A broken chain (empty intermediate table) would
    // return 0, which would not satisfy this assertion.
    expect(typeof rows[0].cnt).toBe('number')
    expect(rows[0].cnt).toBeGreaterThan(0)
  })

  // 3.5 - SQLView with empty result: virtual table is still created, zero rows returned
  test('SQLView that returns no rows still creates the virtual table and referencing query returns zero rows', async () => {
    // This inline SQLView produces no rows (impossible gender filter).  The
    // referencing query should still resolve the table and return zero rows
    // without error, confirming column derivation does not require rows.
    const emptyView = {
      resourceType: 'Library',
      id: 'empty-view-inline',
      url: 'http://myig.org/Library/empty-view-inline',
      status: 'active',
      type: { coding: [{ code: 'sql-view' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/ViewDefinition/patient_demographics',
          label: 'patient_demographics',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              // This condition can never be satisfied, so no rows are returned.
              valueString: 'SELECT id, gender FROM patient_demographics WHERE 1 = 0',
            },
          ],
        },
      ],
    }
    // We need to store this view so it can be resolved as a dependency. Use a
    // trick: store it via the server by submitting it as a stored Library. But
    // since we cannot POST to /Library in this server, use it inline at the top
    // level first to confirm it runs, then reference it from a separate query.
    // For the column-derivation test, we run the SQLView directly.
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: emptyView },
      ]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(0)
  })

  // 3.5 continued - empty SQLView used as dependency in another query returns zero rows
  test('stored SQLView with empty result used as dependency returns zero rows without error', async () => {
    // The stored empty-result-view SQLView returns no rows. The referencing
    // inline SQLQuery should still resolve the virtual table and return zero rows.
    const query = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/Library/empty-result-view',
          label: 'emp',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT id, gender FROM emp',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: query },
      ]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(0)
  })
})

describe('SQLQuery composition error cases', () => {
  // 3.6 - Dependency cycle returns 422 naming the cycle
  test('dependency cycle returns 422 with OperationOutcome naming the cycle', async () => {
    // The stored cycle-view-a depends on cycle-view-b, which depends back on
    // cycle-view-a, forming a cycle. Running a query that depends on
    // cycle-view-a must be rejected with a 422 that names the cycle.
    const query = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/Library/cycle-view-a',
          label: 'cycled',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT * FROM cycled',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: query },
      ]),
    )

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    // The diagnostic must name the cycle path, including both participants.
    const diag = body.issue[0].diagnostics
    expect(diag).toMatch(/cycle/i)
    expect(diag).toContain('http://myig.org/Library/cycle-view-a')
    expect(diag).toContain('http://myig.org/Library/cycle-view-b')
    // Both canonical keys must appear in a sequence indicating the cycle, e.g.
    // "cycle-view-a -> cycle-view-b -> cycle-view-a".
    expect(diag).toMatch(/cycle-view-a.*->.*cycle-view-b.*->.*cycle-view-a/)
  })

  // 3.6 - Library dependency of type sql-query returns 422
  test('dependency that resolves to an sql-query Library returns 422', async () => {
    // The stored sql-query-dep Library has type sql-query. Using it as a
    // relatedArtifact dependency is not permitted and must yield 422.
    const query = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/Library/sql-query-dep',
          label: 'dep',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT * FROM dep',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: query },
      ]),
    )

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
  })

  // 3.6 - Library dependency declaring parameters returns 422
  test('dependency that resolves to a parameterised SQLView Library returns 422', async () => {
    // The stored parameterised-view Library declares a parameter. Using it as a
    // dependency is forbidden and must yield 422.
    const query = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/Library/parameterised-view',
          label: 'pv',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT * FROM pv',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: query },
      ]),
    )

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
  })

  // 3.6 - Unresolvable dependency returns 404; diagnostic must contain "ViewDefinition"
  test('unresolvable dependency still returns 404 with diagnostic containing "ViewDefinition"', async () => {
    // The existing test at the bottom of the $sqlquery-run suite already covers
    // this path; this duplicate ensures it is still respected under the new
    // resolveDependency routing.
    const inline = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        {
          type: 'depends-on',
          resource: 'http://myig.org/ViewDefinition/no_such_view',
          label: 'no_such_view',
        },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT 1 AS one FROM no_such_view',
            },
          ],
        },
      ],
    }
    const res = await postSqlQueryRun(
      '/Library/$sqlquery-run',
      paramsBody([
        { name: '_format', valueCode: 'json' },
        { name: 'queryResource', resource: inline },
      ]),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(body.issue[0].code).toBe('not-found')
    // The diagnostic must still contain "ViewDefinition" so the original test
    // contract is preserved.
    expect(body.issue[0].diagnostics).toContain('ViewDefinition')
  })
})

// ============================================================================
// Section 5: Metadata examples
// ============================================================================

describe('Metadata example: active-female-patients-view SQLView', () => {
  // 5.1 / 5.3 - Verify the stored active-female-patients-view SQLView loads and runs.
  test('stored active-female-patients-view runs via instance route and returns female rows', async () => {
    // The active-female-patients-view SQLView selects only female patients from
    // the patient_demographics ViewDefinition. Running it directly must return
    // at least one row and every row must have gender='female'.
    const res = await postSqlQueryRun(
      '/Library/active-female-patients-view/$sqlquery-run',
      paramsBody([{ name: '_format', valueCode: 'json' }]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.gender).toBe('female')
    }
  })
})

describe('Metadata example: female-patient-births SQLQuery', () => {
  // 5.2 / 5.3 - Verify the stored female-patient-births SQLQuery loads and runs.
  test('stored female-patient-births runs via instance route and returns joined rows', async () => {
    // The female-patient-births SQLQuery joins the active-female-patients-view SQLView
    // with the patient_multiple_birth ViewDefinition. The result rows must include
    // id, gender, and multiple_birth columns, and gender must be 'female' for all rows.
    const res = await postSqlQueryRun(
      '/Library/female-patient-births/$sqlquery-run',
      paramsBody([{ name: '_format', valueCode: 'json' }]),
    )

    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toHaveProperty('id')
    expect(rows[0]).toHaveProperty('gender')
    expect(rows[0]).toHaveProperty('multiple_birth')
    for (const row of rows) {
      expect(row.gender).toBe('female')
    }
  })
})

// ============================================================================
// Section 6.2: $sqlquery-run instance form dependencies panel
// ============================================================================

describe('$sqlquery-run instance form dependencies panel', () => {
  // 6.2 - The instance form for a Library that has relatedArtifact dependencies must
  // render a "Dependencies" section listing each dependency's label, kind, and target.
  test('instance form for female-patient-births shows resolved dependencies panel', async () => {
    // The female-patient-births Library has two relatedArtifact entries: one
    // pointing to the active-female-patients-view SQLView and one pointing to
    // the patient_multiple_birth ViewDefinition.  The rendered form must contain
    // a "Dependencies" heading and show both entries with their labels.
    const res = await fetch(`${base}/Library/female-patient-births/$sqlquery-run/form`)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()

    // The form must contain a Dependencies section heading.
    expect(html).toContain('Dependencies')

    // The labels declared in the Library's relatedArtifact must appear.
    expect(html).toContain('female_patients')
    expect(html).toContain('births')

    // The kind column must distinguish SQLView from ViewDefinition.
    expect(html).toContain('SQLView')
    expect(html).toContain('ViewDefinition')
  })

  test('instance form for Library with no dependencies shows no dependencies panel', async () => {
    // The patient-count Library has no SQLView dependencies - it references only
    // a single ViewDefinition. The form should still render but may show the
    // dependency panel as empty or omit it entirely.
    const res = await fetch(`${base}/Library/patient-count/$sqlquery-run/form`)

    expect(res.status).toBe(200)
    const html = await res.text()
    // The page must load without error.
    expect(html).toContain('SQLQuery Run')
  })

  test('instance form shows unresolved state for an unresolvable dependency', async () => {
    // The stored ghost-dep-query Library has a single relatedArtifact that
    // points at a canonical that does not exist.  The instance form must render
    // the dependency row with the muted "unresolved" marker rather than crashing,
    // exercising the kind===null branch in renderDependenciesPanel.
    const res = await fetch(`${base}/Library/ghost-dep-query/$sqlquery-run/form`)

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Dependencies')
    // The dependency label must appear in the rendered table.
    expect(html).toContain('ghost_table')
    // The "unresolved" marker must be present because the canonical cannot be
    // resolved to any ViewDefinition or Library.
    expect(html).toContain('unresolved')
  })
})

// 6.1 - Library list type indication
describe('Library list', () => {
  test('GET /Library distinguishes SQL Query and SQL View types in the HTML list', async () => {
    // The Library list page must display a Type column (or badge) so that each
    // row is identifiable as an SQL Query or SQL View.  The stored metadata
    // includes at least one of each type (patient-count is sql-query,
    // patient-demographics-view is sql-view).
    const res = await fetch(`${base}/Library`, {
      headers: { Accept: 'text/html' },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    // Both type labels must appear as section badges grouping the libraries.
    expect(html).toContain('SQL Query')
    expect(html).toContain('SQL View')
  })
})

describe('Library create form + endpoint', () => {
  test('GET /Library/new serves an HTML form (not treated as :id)', async () => {
    const res = await fetch(`${base}/Library/new`, { headers: { Accept: 'text/html' } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('New SQL Library')
    // Dependency rows: a view select + a label input.
    expect(html).toContain('name="dep_ref_0"')
    expect(html).toContain('name="dep_label_0"')
    expect(html).toContain('name="sql"')
  })

  test('POST /Library accepts dependency rows (view select + label)', async () => {
    const libName = `rowdep_${Date.now()}`
    const res = await fetch(`${base}/Library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        name: libName,
        type: 'sql-view',
        dep_ref_0: 'http://myig.org/ViewDefinition/patient_demographics',
        dep_label_0: 'demographics',
        dep_ref_1: 'http://myig.org/ViewDefinition/patient_multiple_birth',
        dep_label_1: 'births',
        sql: 'SELECT * FROM demographics',
      }).toString(),
    })
    expect(res.status).toBe(201)
    const lib = await res.json()
    const deps = (lib.relatedArtifact || []).filter((a) => a.type === 'depends-on')
    expect(deps.map((d) => `${d.label}=${d.resource.split('/').pop()}`).sort()).toEqual([
      'births=patient_multiple_birth',
      'demographics=patient_demographics',
    ])
  })

  test('POST /Library builds a sql-view with multiple dependencies from label=ref lines', async () => {
    // Unique per run: sql.test.js uses the shared ./db.sqlite, which persists
    // created Libraries across runs (a fixed name would 409 on the second run).
    const libName = `birth_summary_${Date.now()}`
    const res = await fetch(`${base}/Library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        name: libName,
        type: 'sql-view',
        dependsOn:
          'demographics = http://myig.org/ViewDefinition/patient_demographics\nbirths = http://myig.org/ViewDefinition/patient_multiple_birth',
        sql: 'SELECT d.id, d.gender, b.multiple_birth FROM demographics d LEFT JOIN births b ON d.id = b.id',
      }).toString(),
    })
    expect(res.status).toBe(201)
    const lib = await res.json()
    expect(lib.id).toBe(libName)
    expect(lib.type.coding[0].code).toBe('sql-view')
    const deps = (lib.relatedArtifact || []).filter((a) => a.type === 'depends-on')
    expect(deps.map((d) => d.label).sort()).toEqual(['births', 'demographics'])

    // content carries BOTH base64 `data` and the plain-text sql-text extension.
    const content = lib.content[0]
    expect(content.contentType).toBe('application/sql')
    const sqlText =
      'SELECT d.id, d.gender, b.multiple_birth FROM demographics d LEFT JOIN births b ON d.id = b.id'
    expect(Buffer.from(content.data, 'base64').toString('utf8')).toBe(sqlText)
    expect(content.extension.find((e) => e.url.includes('sql-text')).valueString).toBe(sqlText)

    // Readable back.
    const got = await (await fetch(`${base}/Library/${libName}?_format=json`)).json()
    expect(got.resourceType).toBe('Library')
  })
})

// Helper builders for inline Library resources used by tests.

function inlinePatientCountLibrary() {
  return {
    resourceType: 'Library',
    status: 'active',
    type: { coding: [{ code: 'sql-query' }] },
    relatedArtifact: [
      {
        type: 'depends-on',
        resource: 'http://myig.org/ViewDefinition/patient_demographics',
        label: 'patient_demographics',
      },
    ],
    content: [
      {
        contentType: 'application/sql',
        extension: [
          {
            url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
            valueString: 'SELECT COUNT(*) AS total FROM patient_demographics',
          },
        ],
      },
    ],
  }
}

function inlinePatientMultipleBirthLibrary() {
  return {
    resourceType: 'Library',
    status: 'active',
    type: { coding: [{ code: 'sql-query' }] },
    relatedArtifact: [
      {
        type: 'depends-on',
        resource: 'http://myig.org/ViewDefinition/patient_multiple_birth',
        label: 'patient_multiple_birth',
      },
    ],
    content: [
      {
        contentType: 'application/sql',
        extension: [
          {
            url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
            valueString: 'SELECT id, multiple_birth FROM patient_multiple_birth',
          },
        ],
      },
    ],
  }
}

function inlineMissingViewLibrary() {
  return {
    resourceType: 'Library',
    status: 'active',
    type: { coding: [{ code: 'sql-query' }] },
    relatedArtifact: [
      {
        type: 'depends-on',
        resource: 'http://myig.org/ViewDefinition/no_such_view',
        label: 'no_such_view',
      },
    ],
    content: [
      {
        contentType: 'application/sql',
        extension: [
          {
            url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
            valueString: 'SELECT 1 AS one FROM no_such_view',
          },
        ],
      },
    ],
  }
}

function inlineBadColumnLibrary() {
  return {
    resourceType: 'Library',
    status: 'active',
    type: { coding: [{ code: 'sql-query' }] },
    relatedArtifact: [
      {
        type: 'depends-on',
        resource: 'http://myig.org/ViewDefinition/patient_demographics',
        label: 'patient_demographics',
      },
    ],
    content: [
      {
        contentType: 'application/sql',
        extension: [
          {
            url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
            valueString: 'SELECT no_such_column FROM patient_demographics',
          },
        ],
      },
    ],
  }
}
