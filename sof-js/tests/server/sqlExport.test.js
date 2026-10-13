/**
 * HTTP-level tests for the `$sql-export` operation, following the contract on
 * OperationDefinition-SQLExport and Common Operation Behavior in the SQL on
 * FHIR specification.
 *
 * Author: John Grimes
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { startTestServer, parameters, post, sqlQueryLibrary, patientView, KNOWN_PATIENTS } from './helpers.js'
import { sctToIcd10Map } from './conceptMapFixtures.js'

let server
let base
let tx
const port = 3011
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sof-export-'))

beforeAll(async () => {
  ;({ server, base, tx } = await startTestServer(port, { exportDir }))
}, 120000)

afterAll(async () => {
  server?.close()
  await tx?.close()
  fs.rmSync(exportDir, { recursive: true, force: true })
})

const VIEW_CANONICAL = 'http://myig.org/ViewDefinition/patient_demographics'
const ASYNC = { Prefer: 'respond-async' }

function subject(parts) {
  return { name: 'subject', part: parts }
}

async function outcome(res) {
  const body = await res.json()
  expect(body.resourceType).toBe('OperationOutcome')
  return body
}

function param(resource, name) {
  return resource.parameter?.find((p) => p.name === name)
}

/** Poll the status URL (without following redirects) until it returns 303. */
async function pollUntilDone(statusUrl, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(statusUrl, { redirect: 'manual' })
    if (res.status === 303) return res
    expect(res.status).toBe(202)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('export did not complete')
}

async function kickOff(parameter, headers = ASYNC) {
  return post(base, '/$sql-export', parameters(parameter), headers)
}

async function runExport(parameter) {
  const res = await kickOff(parameter)
  expect(res.status).toBe(202)
  const statusUrl = res.headers.get('Content-Location')
  expect(statusUrl).toMatch(/^http/)
  const done = await pollUntilDone(statusUrl)
  const resultUrl = done.headers.get('Location')
  const result = await fetch(resultUrl)
  return { kickOff: await res.json(), statusUrl, resultUrl, result }
}

// ---------------------------------------------------------------------------
// The asynchronous flow
// ---------------------------------------------------------------------------

describe('$sql-export flow', () => {
  test('mixed job: kick-off, poll, manifest and downloads', async () => {
    const lib = sqlQueryLibrary('SELECT COUNT(*) AS n FROM p', [{ resource: VIEW_CANONICAL, label: 'p' }])
    const {
      kickOff: accepted,
      statusUrl,
      result,
    } = await runExport([
      { name: 'clientTrackingId', valueString: 'job-1' },
      subject([
        { name: 'name', valueString: 'demographics' },
        { name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL },
      ]),
      subject([
        { name: 'name', valueString: 'obs' },
        { name: 'subjectReference', valueReference: { reference: 'ViewDefinition/observations' } },
      ]),
      subject([
        { name: 'name', valueString: 'count' },
        { name: 'subjectResource', resource: lib },
      ]),
      { name: '_format', valueCode: 'csv' },
    ])

    // Kick-off body is informative: exportId, echoed tracking id, accepted, location.
    expect(accepted.resourceType).toBe('Parameters')
    expect(param(accepted, 'status').valueCode).toBe('accepted')
    expect(param(accepted, 'clientTrackingId').valueString).toBe('job-1')
    expect(param(accepted, 'location').valueUri).toBe(statusUrl)
    const exportId = param(accepted, 'exportId').valueString
    expect(exportId).toBeTruthy()

    // Manifest.
    expect(result.status).toBe(200)
    expect(result.headers.get('Content-Type')).toContain('application/fhir+json')
    const manifest = await result.json()
    expect(manifest.resourceType).toBe('Parameters')
    expect(param(manifest, 'exportId').valueString).toBe(exportId)
    expect(param(manifest, 'clientTrackingId').valueString).toBe('job-1')
    expect(param(manifest, 'status').valueCode).toBe('completed')
    expect(param(manifest, '_format').valueCode).toBe('csv')
    expect(param(manifest, 'exportStartTime').valueInstant).toBeTruthy()
    expect(param(manifest, 'exportEndTime').valueInstant).toBeTruthy()
    expect(typeof param(manifest, 'exportDuration').valueInteger).toBe('number')

    const outputs = manifest.parameter.filter((p) => p.name === 'output')
    expect(outputs).toHaveLength(3)
    const byName = Object.fromEntries(
      outputs.map((o) => [
        o.part.find((p) => p.name === 'name').valueString,
        o.part.filter((p) => p.name === 'location'),
      ]),
    )
    expect(Object.keys(byName).sort()).toEqual(['count', 'demographics', 'obs'])

    // Download the count output and check it is CSV with a header.
    const download = await fetch(byName.count[0].valueUri)
    expect(download.status).toBe(200)
    expect(download.headers.get('Content-Type')).toContain('text/csv')
    expect(download.headers.get('Content-Disposition')).toContain('count.csv')
    const [header, row] = (await download.text()).trim().split('\n')
    expect(header).toBe('n')
    expect(Number(row)).toBeGreaterThan(0)

    // The manifest can be retrieved again.
    const again = await fetch(param(accepted, 'location').valueUri.replace(/status$/, 'result'))
    expect(again.status).toBe(200)
  })

  test('defaults to ndjson irrespective of Accept', async () => {
    const { result } = await runExport([
      subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }]),
    ])
    const manifest = await result.json()
    expect(param(manifest, '_format').valueCode).toBe('ndjson')
    const output = manifest.parameter.find((p) => p.name === 'output')
    // Name falls back to the subject's own name element.
    expect(output.part.find((p) => p.name === 'name').valueString).toBe('patient_demographics')
    const location = output.part.find((p) => p.name === 'location').valueUri
    const download = await fetch(location)
    expect(download.headers.get('Content-Type')).toContain('application/x-ndjson')
    const lines = (await download.text()).trim().split('\n')
    expect(JSON.parse(lines[0])).toHaveProperty('id')
  })

  test('a subject with no name element gets a server-generated output name', async () => {
    const { result } = await runExport([subject([{ name: 'subjectResource', resource: patientView() }])])
    const manifest = await result.json()
    const output = manifest.parameter.find((p) => p.name === 'output')
    expect(output.part.find((p) => p.name === 'name').valueString).toBeTruthy()
  })

  test('filters apply to every subject in the job', async () => {
    const { result } = await runExport([
      subject([
        { name: 'name', valueString: 'demo' },
        { name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL },
      ]),
      subject([
        { name: 'name', valueString: 'count' },
        { name: 'subjectReference', valueReference: { reference: 'Library/patient-count' } },
      ]),
      { name: 'patient', valueReference: { reference: `Patient/${KNOWN_PATIENTS[0]}` } },
      { name: '_format', valueCode: 'json' },
    ])
    const manifest = await result.json()
    const outputs = manifest.parameter.filter((p) => p.name === 'output')
    const locationOf = (name) =>
      outputs
        .find((o) => o.part.find((p) => p.name === 'name').valueString === name)
        .part.find((p) => p.name === 'location').valueUri
    const demo = await (await fetch(locationOf('demo'))).json()
    expect(demo.map((r) => r.id)).toEqual([KNOWN_PATIENTS[0]])
    const count = await (await fetch(locationOf('count'))).json()
    expect(count[0].total).toBe(1)
  })

  test('per-subject parameters bind to that subject', async () => {
    const { result } = await runExport([
      subject([
        { name: 'name', valueString: 'one' },
        { name: 'subjectReference', valueReference: { reference: 'Library/patient-by-id' } },
        {
          name: 'parameters',
          resource: parameters([{ name: 'patient_id', valueString: KNOWN_PATIENTS[1] }]),
        },
      ]),
      { name: '_format', valueCode: 'json' },
    ])
    const manifest = await result.json()
    const output = manifest.parameter.find((p) => p.name === 'output')
    const rows = await (await fetch(output.part.find((p) => p.name === 'location').valueUri)).json()
    expect(rows.map((r) => r.id)).toEqual([KNOWN_PATIENTS[1]])
  })

  test('a context entry is resolved once for the job and produces no output entry', async () => {
    const viewUrl = 'https://example.org/ViewDefinition/shared_cohort'
    const a = sqlQueryLibrary('SELECT COUNT(*) AS n FROM c', [{ resource: viewUrl, label: 'c' }])
    const b = sqlQueryLibrary('SELECT MIN(id) AS first_id FROM c', [{ resource: viewUrl, label: 'c' }])
    const { result } = await runExport([
      subject([
        { name: 'name', valueString: 'a' },
        { name: 'subjectResource', resource: a },
      ]),
      subject([
        { name: 'name', valueString: 'b' },
        { name: 'subjectResource', resource: b },
      ]),
      { name: 'context', resource: patientView(viewUrl) },
    ])
    const manifest = await result.json()
    const outputs = manifest.parameter.filter((p) => p.name === 'output')
    expect(outputs.map((o) => o.part.find((p) => p.name === 'name').valueString).sort()).toEqual(['a', 'b'])
  })

  test('a supplied ConceptMap is exposed as a relation to every subject of the job', async () => {
    const map = sctToIcd10Map()
    const dep = [{ resource: map.url, label: 'm' }]
    const { result } = await runExport([
      subject([
        { name: 'name', valueString: 'mapped' },
        { name: 'subjectResource', resource: sqlQueryLibrary('SELECT COUNT(target_code) AS n FROM m', dep) },
      ]),
      subject([
        { name: 'name', valueString: 'nomap' },
        {
          name: 'subjectResource',
          resource: sqlQueryLibrary('SELECT source_code FROM m WHERE target_code IS NULL', dep),
        },
      ]),
      { name: 'context', resource: map },
      { name: '_format', valueCode: 'json' },
    ])
    const manifest = await result.json()
    const outputs = manifest.parameter.filter((p) => p.name === 'output')
    const download = async (name) => {
      const output = outputs.find((o) => o.part.find((p) => p.name === 'name').valueString === name)
      return (await fetch(output.part.find((p) => p.name === 'location').valueUri)).json()
    }
    expect(await download('mapped')).toEqual([{ n: 2 }])
    expect(await download('nomap')).toEqual([{ source_code: '102499006' }])
    expect(tx.requests.filter((r) => r.path === '/ConceptMap')).toHaveLength(0)
  })

  test('cancellation: DELETE on the status URL is 202 and later polls are 404', async () => {
    const res = await kickOff([subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }])])
    expect(res.status).toBe(202)
    const statusUrl = res.headers.get('Content-Location')
    const cancel = await fetch(statusUrl, { method: 'DELETE' })
    expect(cancel.status).toBe(202)
    const after = await fetch(statusUrl, { redirect: 'manual' })
    expect(after.status).toBe(404)
    const result = await fetch(statusUrl.replace(/status$/, 'result'))
    expect(result.status).toBe(404)
  })

  test('status and result URLs for an unknown job are 404', async () => {
    expect((await fetch(`${base}/$sql-export/no-such-job/status`, { redirect: 'manual' })).status).toBe(404)
    expect((await fetch(`${base}/$sql-export/no-such-job/result`)).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Rejected requests (synchronous, at kick-off)
// ---------------------------------------------------------------------------

describe('$sql-export rejected requests', () => {
  test('GET on the operation endpoint is 400 required', async () => {
    const res = await fetch(`${base}/$sql-export?subjectCanonical=${encodeURIComponent(VIEW_CANONICAL)}`)
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('required')
  })

  test('missing Prefer: respond-async is 400 required', async () => {
    const res = await kickOff([subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }])], {})
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('required')
  })

  test('no subject is 400 required naming subject', async () => {
    const res = await kickOff([{ name: '_format', valueCode: 'csv' }])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('required')
    expect(body.issue[0].expression).toEqual(['subject'])
  })

  test('a repetition with two naming forms is 400 invalid', async () => {
    const res = await kickOff([
      subject([
        { name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL },
        { name: 'subjectReference', valueReference: { reference: 'ViewDefinition/observations' } },
      ]),
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['subject[0]'])
  })

  test('a repetition with no naming form is 400 invalid naming the repetition', async () => {
    const res = await kickOff([subject([{ name: 'name', valueString: 'only-a-name' }])])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['subject[0]'])
  })

  test('two names that sanitise to the same file name are rejected as a collision', async () => {
    const res = await kickOff([
      subject([
        { name: 'name', valueString: 'a b' },
        { name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL },
      ]),
      subject([
        { name: 'name', valueString: 'a_b' },
        { name: 'subjectReference', valueReference: { reference: 'ViewDefinition/observations' } },
      ]),
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].expression).toEqual(['subject'])
  })

  test('an output named job in json format does not clobber the job record', async () => {
    const { result } = await runExport([
      subject([
        { name: 'name', valueString: 'job' },
        { name: 'subjectReference', valueReference: { reference: 'Library/patient-count' } },
      ]),
      { name: '_format', valueCode: 'json' },
    ])
    expect(result.status).toBe(200)
    const manifest = await result.json()
    const output = manifest.parameter.find((p) => p.name === 'output')
    const rows = await (await fetch(output.part.find((p) => p.name === 'location').valueUri)).json()
    expect(rows[0]).toHaveProperty('total')
  })

  test('a SQL syntax error in a subject is rejected at kick-off with 422', async () => {
    const lib = sqlQueryLibrary('SELEC nope FROM p', [{ resource: VIEW_CANONICAL, label: 'p' }])
    const res = await kickOff([subject([{ name: 'subjectResource', resource: lib }])])
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['subject[0].subjectResource'])
  })

  test('an invalid FHIRPath expression in a ViewDefinition subject is rejected at kick-off with 422', async () => {
    const view = patientView()
    view.select[0].column[0].path = 'id.((('
    const res = await kickOff([subject([{ name: 'subjectResource', resource: view }])])
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
  })

  test('two repetitions producing the same output name is 400 invalid naming subject', async () => {
    const res = await kickOff([
      subject([
        { name: 'name', valueString: 'demographics' },
        { name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL },
      ]),
      subject([
        { name: 'name', valueString: 'demographics' },
        { name: 'subjectReference', valueReference: { reference: 'ViewDefinition/observations' } },
      ]),
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['subject'])
    expect(body.issue[0].diagnostics).toContain('demographics')
  })

  test('parameters on a ViewDefinition subject is 400 invalid', async () => {
    const res = await kickOff([
      subject([
        { name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL },
        { name: 'parameters', resource: parameters([{ name: 'x', valueString: 'y' }]) },
      ]),
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression[0]).toContain('parameters')
  })

  test('_format=fhir is 400 invalid on export', async () => {
    const res = await kickOff([
      subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }]),
      { name: '_format', valueCode: 'fhir' },
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('invalid')
    expect(body.issue[0].expression).toEqual(['_format'])
  })

  test('_format=parquet is 400 not-supported', async () => {
    const res = await kickOff([
      subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }]),
      { name: '_format', valueCode: 'parquet' },
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-supported')
  })

  test('_limit is 400 invalid on export', async () => {
    const res = await kickOff([
      subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }]),
      { name: '_limit', valueInteger: 10 },
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].expression).toEqual(['_limit'])
  })

  test('source is 400 not-supported', async () => {
    const res = await kickOff([
      subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }]),
      { name: 'source', valueString: 'gs://bucket' },
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-supported')
    expect(body.issue[0].expression).toEqual(['source'])
  })

  test('several subject problems are reported in one OperationOutcome', async () => {
    const res = await kickOff([
      subject([{ name: 'subjectCanonical', valueCanonical: 'http://example.org/nope' }]),
      subject([
        {
          name: 'subjectResource',
          resource: { resourceType: 'Library', status: 'active', type: { coding: [] } },
        },
      ]),
    ])
    expect(res.status).toBe(404)
    const body = await outcome(res)
    expect(body.issue).toHaveLength(2)
    expect(body.issue.map((i) => i.code).sort()).toEqual(['invalid', 'not-found'])
    expect(body.issue.map((i) => i.expression[0]).sort()).toEqual([
      'subject[0].subjectCanonical',
      'subject[1].subjectResource',
    ])
  })

  test('an unknown patient is 400 not-found naming patient', async () => {
    const res = await kickOff([
      subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }]),
      { name: 'patient', valueReference: { reference: 'Patient/nope' } },
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-found')
    expect(body.issue[0].expression).toEqual(['patient'])
  })

  test('an unmatched context entry is 400 invalid naming context', async () => {
    const res = await kickOff([
      subject([{ name: 'subjectCanonical', valueCanonical: VIEW_CANONICAL }]),
      { name: 'context', resource: patientView('https://example.org/ViewDefinition/unused') },
    ])
    expect(res.status).toBe(400)
    const body = await outcome(res)
    expect(body.issue[0].expression).toEqual(['context'])
  })

  test('a dependency neither supplied nor resolvable is 404 at kick-off', async () => {
    const res = await kickOff([
      subject([{ name: 'subjectReference', valueReference: { reference: 'Library/ghost-dep-query' } }]),
    ])
    expect(res.status).toBe(404)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-found')
  })

  test('a ConceptMap the relation cannot represent is 422 at kick-off', async () => {
    const map = sctToIcd10Map()
    map.group[0].element[0].target[0].product = [{ attribute: 'laterality', valueCode: 'left' }]
    const res = await kickOff([
      subject([
        {
          name: 'subjectResource',
          resource: sqlQueryLibrary('SELECT * FROM m', [{ resource: map.url, label: 'm' }]),
        },
      ]),
      { name: 'context', resource: map },
    ])
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('processing')
    expect(body.issue[0].diagnostics).toContain('product')
  })
})
