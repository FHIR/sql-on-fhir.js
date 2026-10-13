/**
 * HTTP-level tests for the `$sql-run` and `$sql-export` HTML forms.
 *
 * Author: John Grimes
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { startTestServer, KNOWN_PATIENTS } from './helpers.js'

let server
let base
let tx
const port = 3012
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sof-forms-'))

beforeAll(async () => {
  ;({ server, base, tx } = await startTestServer(port, { exportDir }))
}, 120000)

afterAll(async () => {
  server?.close()
  await tx?.close()
  fs.rmSync(exportDir, { recursive: true, force: true })
})

async function postForm(pathname, fields) {
  const body = new URLSearchParams()
  for (const [name, values] of Object.entries(fields)) {
    for (const v of Array.isArray(values) ? values : [values]) body.append(name, v)
  }
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true' },
    body,
  })
}

describe('$sql-run form', () => {
  test('renders one control per supported parameter and preselects the requested subject', async () => {
    const res = await fetch(`${base}/$sql-run/form?subject=Library/patient-by-id`)
    expect(res.status).toBe(200)
    const html = await res.text()
    for (const name of [
      'subjectStored',
      'subjectCanonical',
      'subjectResource',
      'context',
      'resource',
      '_format',
      'header',
      'patient',
      'group',
      '_since',
      '_limit',
    ]) {
      expect(html).toContain(`name="${name}"`)
    }
    expect(html).toContain('value="Library/patient-by-id" selected')
    // The Library's declared parameter becomes a field.
    expect(html).toContain('name="param.patient_id"')
    // parquet is not offered because the server rejects it.
    expect(html).not.toContain('value="parquet"')
  })

  test('submitting a stored Library with a typed parameter renders the rows as a table', async () => {
    const res = await postForm('/$sql-run/form', {
      subjectStored: 'Library/patient-by-id',
      'param.patient_id': KNOWN_PATIENTS[0],
      _format: 'json',
      header: 'true',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<th>id</th>')
    expect(html).toContain(KNOWN_PATIENTS[0])
  })

  test('an operation error is rendered as an OperationOutcome issue list, not a 500', async () => {
    const res = await postForm('/$sql-run/form', {
      subjectStored: 'Library/ghost-dep-query',
      _format: 'json',
    })
    expect(res.status).toBeLessThan(500)
    const html = await res.text()
    expect(html).toContain('not-found')
  })

  test('invalid JSON in a textarea is reported as an error', async () => {
    const res = await postForm('/$sql-run/form', { subjectResource: '{bad', _format: 'json' })
    expect(res.status).toBeLessThan(500)
    expect(await res.text()).toMatch(/JSON/)
  })
})

describe('$sql-export form', () => {
  test('renders repeating subject rows and the job-level parameters', async () => {
    const res = await fetch(`${base}/$sql-export/form`)
    expect(res.status).toBe(200)
    const html = await res.text()
    for (const name of [
      'subjectName[]',
      'subjectStored[]',
      'subjectCanonical[]',
      'subjectResource[]',
      'subjectParameters[]',
      'clientTrackingId',
      'context',
      '_format',
      'header',
      'patient',
      'group',
      '_since',
    ]) {
      expect(html).toContain(`name="${name}"`)
    }
    expect(html).not.toContain('value="fhir"')
  })

  test('submitting two subjects starts a job and the status panel ends with download links', async () => {
    const res = await postForm('/$sql-export/form', {
      'subjectName[]': ['demo', 'count'],
      'subjectStored[]': ['ViewDefinition/patient_demographics', 'Library/patient-count'],
      _format: 'csv',
      header: 'true',
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    const match = /\$sql-export\/form\/status\/([0-9a-f-]+)/.exec(html)
    expect(match).toBeTruthy()
    let panel = ''
    for (let i = 0; i < 30 && !/completed/.test(panel); i++) {
      await new Promise((r) => setTimeout(r, 200))
      panel = await (await fetch(`${base}/$sql-export/form/status/${match[1]}`)).text()
    }
    expect(panel).toContain('completed')
    expect(panel).toContain('demo.csv')
    expect(panel).toContain('count.csv')
    expect(panel).not.toContain('hx-trigger')
  })
})
