// Isolated SQLite file + CSV dir so this suite does not collide with others.
// Must be set before startServer (the modules read these on first use).
const STAMP = Date.now()
process.env.DB_PATH = `/tmp/sof-mv-test-${STAMP}.sqlite`
process.env.MV_CSV_DIR = `/tmp/sof-mv-csv-${STAMP}`

import fs from 'fs'
import path from 'path'
import { startServer } from '../../src/server.js'

var server
const port = 3011
const base = `http://localhost:${port}`

const VIEW_URL = 'http://myig.org/ViewDefinition/patient_demographics'

beforeAll(async () => {
  server = await startServer({ port })
  await waitForData()
}, 90000)

afterAll(async () => {
  server?.close()
})

async function waitForData(maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${base}/ViewDefinition/patient_demographics/$run?format=json`)
      if (res.status === 200) {
        const rows = await res.json()
        if (Array.isArray(rows) && rows.length > 0) return
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('FHIR data did not load within the allotted time')
}

function postMV(body) {
  return fetch(`${base}/MaterializedView`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json' },
    body: JSON.stringify(body),
  })
}

describe('MaterializedView resource', () => {
  let id

  test('POST materializes a ViewDefinition into a ready relation (sqlite)', async () => {
    const res = await postMV({ view: VIEW_URL, destination: 'sqlite', name: 'patients' })
    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toMatch(/\/MaterializedView\/mv-/)
    const mv = await res.json()
    id = mv.id
    expect(mv.status).toBe('ready')
    expect(mv.destination).toBe('sqlite')
    expect(mv.type).toEqual({ system: 'http://sql-on-fhir.org/materialize', code: 'sqlite' })
    expect(mv.rowCount).toBeGreaterThan(0)
  })

  test('$data returns the materialized rows with the view columns', async () => {
    const res = await fetch(`${base}/MaterializedView/${id}/$data`)
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBeGreaterThan(0)
    expect(Object.keys(rows[0]).sort()).toEqual(['date_of_birth', 'gender', 'id'])
  })

  test('search by destination + status finds it', async () => {
    const res = await fetch(`${base}/MaterializedView?destination=sqlite&status=ready`)
    const bundle = await res.json()
    expect(bundle.entry.map((e) => e.resource.id)).toContain(id)
  })

  test('second materialization of the same (view, destination) is 409', async () => {
    const res = await postMV({ view: VIEW_URL, destination: 'sqlite', name: 'patients2' })
    expect(res.status).toBe(409)
  })

  test('reusing (destination, name) for a different view is 409', async () => {
    const res = await postMV({
      view: 'http://myig.org/ViewDefinition/observations',
      destination: 'sqlite',
      name: 'patients',
    })
    expect(res.status).toBe(409)
  })

  test('PUT rebuilds the relation', async () => {
    const res = await fetch(`${base}/MaterializedView/${id}`, { method: 'PUT' })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('ready')
  })

  test('DELETE drops it; subsequent GET is 404', async () => {
    expect((await fetch(`${base}/MaterializedView/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(`${base}/MaterializedView/${id}`)).status).toBe(404)
  })

  test('missing view is rejected with 400', async () => {
    expect((await postMV({ destination: 'sqlite', name: 'noview' })).status).toBe(400)
  })
})

describe('MaterializedView — csv destination', () => {
  test('materializes the same view to a CSV file on the csv destination', async () => {
    // same view, different destination — allowed (one per (view, destination))
    const res = await postMV({ view: VIEW_URL, destination: 'csv', name: 'patients' })
    expect(res.status).toBe(201)
    const mv = await res.json()
    expect(mv.destination).toBe('csv')
    expect(mv.type.code).toBe('csv')
    expect(mv.rowCount).toBeGreaterThan(0)

    // the CSV file exists on disk
    const file = path.join(process.env.MV_CSV_DIR, 'patients.csv')
    expect(fs.existsSync(file)).toBe(true)
    const header = fs.readFileSync(file, 'utf8').split('\n')[0]
    expect(header).toBe('id,date_of_birth,gender')

    // $data parses the CSV back into rows
    const data = await (await fetch(`${base}/MaterializedView/${mv.id}/$data`)).json()
    expect(data.length).toBe(mv.rowCount)
    expect(Object.keys(data[0]).sort()).toEqual(['date_of_birth', 'gender', 'id'])

    // DELETE removes the file
    await fetch(`${base}/MaterializedView/${mv.id}`, { method: 'DELETE' })
    expect(fs.existsSync(file)).toBe(false)
  })

  test('an unknown destination is rejected with 400', async () => {
    const res = await postMV({ view: VIEW_URL, destination: 'redshift', name: 'patients' })
    expect(res.status).toBe(400)
    const oo = await res.json()
    expect(oo.issue[0].diagnostics).toMatch(/Unsupported destination/)
  })
})
