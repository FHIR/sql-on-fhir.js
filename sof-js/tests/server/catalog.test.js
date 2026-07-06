// Isolated SQLite file (passed via config, never the shared process.env global,
// so it can't clobber other suites). The catalog pages only need canonical
// ViewDefinitions and Libraries, so no FHIR data wait is required.
import { startServer } from '../../src/server.js'

const STAMP = Date.now()
const DB_PATH = `/tmp/sof-catalog-${STAMP}.sqlite`

var server
const port = 3014
const base = `http://localhost:${port}`

beforeAll(async () => {
  server = await startServer({ port, dbPath: DB_PATH })
}, 90000)

afterAll(async () => {
  server?.close()
})

describe('catalog pages — Views vs Queries', () => {
  test('GET /Views (json) aggregates ViewDefinitions and SQLViews, excludes SQL Query', async () => {
    const bundle = await (await fetch(`${base}/Views?_format=json`)).json()
    expect(bundle.resourceType).toBe('Bundle')
    const entries = bundle.entry.map((e) => e.resource)
    // Contains ViewDefinitions and sql-view Libraries...
    expect(entries.some((r) => r.resourceType === 'ViewDefinition')).toBe(true)
    expect(
      entries.some(
        (r) => r.resourceType === 'Library' && (r.type?.coding || []).some((c) => c.code === 'sql-view'),
      ),
    ).toBe(true)
    // ...but no sql-query Libraries.
    expect(entries.some((r) => (r.type?.coding || []).some((c) => c.code === 'sql-query'))).toBe(false)
  })

  test('GET /Queries (json) contains only SQL Query Libraries', async () => {
    const bundle = await (await fetch(`${base}/Queries?_format=json`)).json()
    const entries = bundle.entry.map((e) => e.resource)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((r) => (r.type?.coding || []).some((c) => c.code === 'sql-query'))).toBe(true)
  })

  test('GET /Views (html) shows both section badges and a materialize action', async () => {
    const html = await (await fetch(`${base}/Views`, { headers: { Accept: 'text/html' } })).text()
    expect(html).toContain('>ViewDefinition<')
    expect(html).toContain('>SQLView<')
    expect(html).toContain('materialize')
  })

  test('the New MaterializedView form preselects a ?view= query param', async () => {
    const view = 'http://myig.org/Library/active-female-patients-view'
    const html = await (
      await fetch(`${base}/MaterializedView/new?view=${encodeURIComponent(view)}`, {
        headers: { Accept: 'text/html' },
      })
    ).text()
    expect(html).toContain(`value="${view}" selected`)
  })
})
