// Isolated SQLite file (passed via config, not the shared process.env global)
// so creating ViewDefinitions here does not touch other suites.
import { startServer } from '../../src/server.js'

const STAMP = Date.now()
const DB_PATH = `/tmp/sof-vd-create-${STAMP}.sqlite`

var server
const port = 3013
const base = `http://localhost:${port}`

beforeAll(async () => {
  server = await startServer({ port, dbPath: DB_PATH })
}, 90000)

afterAll(async () => {
  server?.close()
})

describe('ViewDefinition create form + endpoint', () => {
  test('GET /ViewDefinition/new serves an HTML form (not treated as :id)', async () => {
    const res = await fetch(`${base}/ViewDefinition/new`, { headers: { Accept: 'text/html' } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('New View Definition')
    expect(html).toContain('name="definition"')
    expect(html).toContain('action="/ViewDefinition"')
  })

  test('POST creates from the JSON definition and it becomes readable', async () => {
    const definition = JSON.stringify({
      resourceType: 'ViewDefinition',
      name: 'my_new_view',
      resource: 'Patient',
      status: 'draft',
      select: [{ column: [{ name: 'id', path: 'getResourceKey()' }] }],
    })
    const res = await fetch(`${base}/ViewDefinition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        name: 'my_new_view',
        resource: 'Patient',
        status: 'draft',
        definition,
      }).toString(),
    })
    expect(res.status).toBe(201)
    const vd = await res.json()
    expect(vd.id).toBe('my_new_view')
    expect(vd.resourceType).toBe('ViewDefinition')
    expect(vd.url).toBe('http://myig.org/ViewDefinition/my_new_view')

    // readable back as JSON
    const got = await (await fetch(`${base}/ViewDefinition/my_new_view?_format=json`)).json()
    expect(got.name).toBe('my_new_view')
    expect(got.resource).toBe('Patient')
  })

  test('convenience fields override the parsed JSON', async () => {
    const definition = JSON.stringify({
      resourceType: 'ViewDefinition',
      name: 'ignored',
      resource: 'Patient',
    })
    const res = await fetch(`${base}/ViewDefinition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        name: 'obs_view',
        resource: 'Observation',
        status: 'active',
        definition,
      }).toString(),
    })
    expect(res.status).toBe(201)
    const vd = await res.json()
    expect(vd.name).toBe('obs_view')
    expect(vd.resource).toBe('Observation')
    expect(vd.status).toBe('active')
  })

  test('invalid JSON re-renders the form with an error (HTML)', async () => {
    const res = await fetch(`${base}/ViewDefinition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: new URLSearchParams({ definition: '{ not json ' }).toString(),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Invalid JSON')
    expect(html).toContain('New View Definition')
  })

  test('invalid JSON to an API client returns a 400 OperationOutcome, not HTML (P3)', async () => {
    const res = await fetch(`${base}/ViewDefinition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/json' },
      body: JSON.stringify({ definition: '{ not json ' }),
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('json')
    const oo = await res.json()
    expect(oo.resourceType).toBe('OperationOutcome')
    expect(oo.issue[0].diagnostics).toMatch(/Invalid JSON/)
  })

  test('a colliding id is rejected with 409, not silently overwritten (#3)', async () => {
    const mk = (name) =>
      fetch(`${base}/ViewDefinition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ name, resource: 'Patient' }).toString(),
      })
    // Both names sanitize to id "dup_view".
    const first = await mk('Dup View')
    expect(first.status).toBe(201)
    const second = await mk('dup-view')
    expect(second.status).toBe(409)
    const oo = await second.json()
    expect(oo.issue[0].diagnostics).toMatch(/already exists/)

    // The original is intact (not overwritten).
    const got = await (await fetch(`${base}/ViewDefinition/dup_view?_format=json`)).json()
    expect(got.name).toBe('Dup View')
  })

  test('the new view then appears in the list', async () => {
    const bundle = await (await fetch(`${base}/ViewDefinition?_format=json`)).json()
    const ids = bundle.entry.map((e) => e.resource.id)
    expect(ids).toContain('my_new_view')
    expect(ids).toContain('obs_view')
  })
})
