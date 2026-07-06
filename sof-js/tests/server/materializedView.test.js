// Isolated SQLite file + CSV dir so this suite does not collide with others.
// dbPath is passed via config (never the shared process.env global); MV_CSV_DIR
// is read only by this suite's CSV code, so it stays a local env override.
import fs from 'fs'
import path from 'path'
import { Database } from 'bun:sqlite'
import { startServer } from '../../src/server.js'

const STAMP = Date.now()
const DB_PATH = `/tmp/sof-mv-test-${STAMP}.sqlite`
process.env.MV_CSV_DIR = `/tmp/sof-mv-csv-${STAMP}`

var server
const port = 3011
const base = `http://localhost:${port}`

const VIEW_URL = 'http://myig.org/ViewDefinition/patient_demographics'

beforeAll(async () => {
  server = await startServer({ port, dbPath: DB_PATH })
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

  test('PUT rebuilds the relation atomically (no dupes/leftovers)', async () => {
    // Two consecutive rebuilds. FHIR data is fully loaded by now (earlier tests
    // ran), so both rebuild against the same input — the DROP+CREATE+INSERT
    // transaction must yield identical relations, never doubling or leaving a
    // partial insert. (We compare the two rebuilds, not the POST-time count,
    // which can differ while background data loading is still in flight.)
    const first = await fetch(`${base}/MaterializedView/${id}`, { method: 'PUT' })
    expect(first.status).toBe(200)
    const mv1 = await first.json()
    expect(mv1.status).toBe('ready')
    const data1 = await (await fetch(`${base}/MaterializedView/${id}/$data`)).json()

    const second = await fetch(`${base}/MaterializedView/${id}`, { method: 'PUT' })
    const mv2 = await second.json()
    const data2 = await (await fetch(`${base}/MaterializedView/${id}/$data`)).json()

    // Relation matches its reported rowCount (no partial insert) and is
    // idempotent across rebuilds (no doubling / no leftovers).
    expect(data1.length).toBe(mv1.rowCount)
    expect(data2.length).toBe(mv2.rowCount)
    expect(data2.length).toBe(data1.length)
    expect(data2).toEqual(data1)
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

describe('optional input parameters (type, staleness, identifier, dependsOn)', () => {
  test('nested JSON params are stored on the resource', async () => {
    const res = await postMV({
      view: 'http://myig.org/ViewDefinition/patient_multiple_birth',
      destination: 'csv',
      name: 'params_nested',
      type: { system: 'postgres', code: 'unlogged-table' },
      staleness: { value: 1, unit: 'h', code: 'h', system: 'http://unitsofmeasure.org' },
      identifier: { system: 'urn:acme', value: 'MB-1' },
      dependsOn: [{ reference: 'MaterializedView/mv-upstream' }],
    })
    expect(res.status).toBe(201)
    const mv = await res.json()
    expect(mv.type).toEqual({ system: 'postgres', code: 'unlogged-table' })
    expect(mv.staleness.value).toBe(1)
    expect(mv.identifier).toEqual({ system: 'urn:acme', value: 'MB-1' })
    expect(mv.dependsOn).toEqual([{ reference: 'MaterializedView/mv-upstream' }])
  })

  test('flat form fields are normalized into nested shape', async () => {
    const res = await fetch(`${base}/MaterializedView`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        view: 'http://myig.org/ViewDefinition/observations',
        destination: 'csv',
        name: 'params_flat',
        type_system: 'file',
        type_code: 'parquet',
        staleness_value: '30',
        staleness_unit: 'min',
        identifier_system: 'urn:acme',
        identifier_value: 'OBS-9',
        dependsOn: 'MaterializedView/mv-a\nMaterializedView/mv-b',
      }).toString(),
    })
    expect(res.status).toBe(201)
    const mv = await res.json()
    expect(mv.type).toEqual({ system: 'file', code: 'parquet' })
    expect(mv.staleness).toEqual({ value: 30, unit: 'min', code: 'min', system: 'http://unitsofmeasure.org' })
    expect(mv.identifier).toEqual({ system: 'urn:acme', value: 'OBS-9' })
    expect(mv.dependsOn).toEqual([
      { reference: 'MaterializedView/mv-a' },
      { reference: 'MaterializedView/mv-b' },
    ])
  })

  test('empty flat fields collapse — defaults apply, nothing leaks', async () => {
    const res = await fetch(`${base}/MaterializedView`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        view: 'http://myig.org/ViewDefinition/observations',
        destination: 'sqlite',
        name: 'params_empty',
        type_system: '',
        type_code: '',
        staleness_value: '',
        staleness_unit: '',
        identifier_system: '',
        identifier_value: '',
        dependsOn: '',
      }).toString(),
    })
    expect(res.status).toBe(201)
    const mv = await res.json()
    expect(mv.type).toEqual({ system: 'http://sql-on-fhir.org/materialize', code: 'sqlite' })
    expect(mv.staleness).toBeUndefined()
    expect(mv.identifier).toBeUndefined()
    expect(mv.dependsOn).toBeUndefined()
    expect(mv.type_system).toBeUndefined() // flat keys did not leak
  })
})

describe('$run with destination — serves from the materialization, not a recompute', () => {
  let id

  test('materialize patient_demographics on sqlite for run-by-destination', async () => {
    const res = await postMV({ view: VIEW_URL, destination: 'sqlite', name: 'run_patients' })
    expect(res.status).toBe(201)
    id = (await res.json()).id
  })

  test('$run?destination=sqlite returns exactly the materialized relation', async () => {
    const fromData = await (await fetch(`${base}/MaterializedView/${id}/$data`)).json()
    const res = await fetch(`${base}/ViewDefinition/patient_demographics/$run?destination=sqlite&format=json`)
    expect(res.status).toBe(200)
    const fromRun = await res.json()
    expect(Array.isArray(fromRun)).toBe(true)
    expect(fromRun.length).toBe(fromData.length)
    // Byte-for-byte the rows stored in the relation (incl. SQLite coercion),
    // which proves the runner read the materialization rather than recomputing.
    expect(fromRun).toEqual(fromData)
  })

  test('$run?destination=sqlite for a view not materialized there is 404', async () => {
    const res = await fetch(
      `${base}/ViewDefinition/patient_multiple_birth/$run?destination=sqlite&format=json`,
    )
    expect(res.status).toBe(404)
  })

  test('$run with an unsupported destination is 400', async () => {
    const res = await fetch(
      `${base}/ViewDefinition/patient_demographics/$run?destination=redshift&format=json`,
    )
    expect(res.status).toBe(400)
    const oo = await res.json()
    expect(oo.issue[0].diagnostics).toMatch(/Unsupported destination/)
  })

  test('without destination the runner still recomputes from FHIR data', async () => {
    const res = await fetch(`${base}/ViewDefinition/patient_demographics/$run?format=json`)
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBeGreaterThan(0)
    expect(Object.keys(rows[0]).sort()).toEqual(['date_of_birth', 'gender', 'id'])
  })

  test('$run 400 content-negotiates: HTML client gets an HTML page, not raw JSON (#2)', async () => {
    const res = await fetch(`${base}/ViewDefinition/patient_demographics/$run?destination=redshift`, {
      headers: { Accept: 'text/html' },
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Unsupported destination')
  })
})

describe('$sqlquery-run with destination — query over materializations', () => {
  // active-female-patients-view (a SQLView) depends on patient_demographics.
  // Ensure that dependency is materialized on both destinations regardless of
  // what earlier describe blocks created/deleted (409 = already present).
  const LIB = 'active-female-patients-view'

  beforeAll(async () => {
    for (const [destination, name] of [
      ['sqlite', 'sq_pd'],
      ['csv', 'csv_pd'],
    ]) {
      await postMV({ view: VIEW_URL, destination, name })
    }
  })

  function runForm(fields) {
    return fetch(`${base}/Library/${LIB}/$sqlquery-run/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _format: 'json', ...fields }).toString(),
    })
  }

  // The form response embeds the JSON result inside an HTML <pre> (entity-escaped).
  async function resultRowCount(res) {
    const html = await res.text()
    return (html.match(/date_of_birth/g) || []).length
  }

  test('the run form exposes a Destination select with the supported destinations', async () => {
    const html = await (await fetch(`${base}/Library/${LIB}/$sqlquery-run/form`)).text()
    expect(html).toContain('name="destination"')
    expect(html).toContain('recompute live')
    expect(html).toContain('>sqlite<')
    expect(html).toContain('>csv<')
  })

  test('destination=sqlite serves the query from the materialization and matches a live recompute', async () => {
    const live = await resultRowCount(await runForm({}))
    const sqlite = await resultRowCount(await runForm({ destination: 'sqlite' }))
    const csv = await resultRowCount(await runForm({ destination: 'csv' }))
    expect(live).toBeGreaterThan(0)
    expect(sqlite).toBe(live)
    expect(csv).toBe(live)
  })

  test('a dependency not materialized on the destination yields a not-materialized error', async () => {
    // female-patient-births depends on patient_multiple_birth, which is NOT
    // materialized on csv in this suite.
    const res = await fetch(`${base}/Library/female-patient-births/$sqlquery-run/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _format: 'json', destination: 'csv' }).toString(),
    })
    const html = await res.text()
    expect(html).toMatch(/not materialized on destination 'csv'/)
  })

  test('an EMPTY materialized SQLView dependency keeps its columns (no "no such column") (P2)', async () => {
    // empty-result-view is a SQLView with columns (id, gender) but zero rows.
    // Materialize it, then run a query that references one of its columns
    // against the destination — deriving the virtual-table schema from the
    // (empty) rows would drop the columns and break the query.
    await postMV({
      view: 'http://myig.org/Library/empty-result-view',
      destination: 'sqlite',
      name: 'empty_ev',
    })
    const queryResource = {
      resourceType: 'Library',
      status: 'active',
      type: { coding: [{ code: 'sql-query' }] },
      relatedArtifact: [
        { type: 'depends-on', label: 'ev', resource: 'http://myig.org/Library/empty-result-view' },
      ],
      content: [
        {
          contentType: 'application/sql',
          extension: [
            {
              url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
              valueString: 'SELECT gender FROM ev',
            },
          ],
        },
      ],
    }
    const res = await fetch(`${base}/$sqlquery-run/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _format: 'json',
        destination: 'sqlite',
        queryResource: JSON.stringify(queryResource),
      }).toString(),
    })
    const html = await res.text()
    expect(html).not.toMatch(/no such column/i)
    expect(html).toContain('0 rows') // succeeds with an empty result set
  })
})

describe('cascading materialization of dependent views', () => {
  // A 2-level SQLView chain:
  //   female-demographics-view -> patient-demographics-view -> patient_demographics
  const TOP = 'http://myig.org/Library/female-demographics-view'
  const MID = 'http://myig.org/Library/patient-demographics-view'
  const LEAF = 'http://myig.org/ViewDefinition/patient_demographics'

  const searchOne = async (view, destination) =>
    (
      await fetch(`${base}/MaterializedView?view=${encodeURIComponent(view)}&destination=${destination}`)
    ).json()

  test('materializing a SQLView cascades its whole dependency DAG onto the destination', async () => {
    const res = await postMV({ view: TOP, destination: 'csv', name: 'female_demo' })
    expect(res.status).toBe(201)
    const mv = await res.json()

    // Top links to its immediate dependency's materialization.
    expect(Array.isArray(mv.dependsOn)).toBe(true)
    expect(mv.dependsOn.length).toBe(1)
    expect(mv.dependsOn[0].reference).toMatch(/^MaterializedView\/mv-/)

    // The mid-level SQLView was materialized on the same destination...
    const mid = await searchOne(MID, 'csv')
    expect(mid.total).toBe(1)
    // ...and it in turn links to the leaf ViewDefinition materialization.
    expect(mid.entry[0].resource.dependsOn?.length).toBe(1)

    // The leaf ViewDefinition is materialized on the destination too.
    const leaf = await searchOne(LEAF, 'csv')
    expect(leaf.total).toBeGreaterThanOrEqual(1)

    // The top relation is queryable and non-trivial.
    expect(mv.rowCount).toBeGreaterThan(0)
    const data = await (await fetch(`${base}/MaterializedView/${mv.id}/$data`)).json()
    expect(data.length).toBe(mv.rowCount)
  })

  test('an already-materialized dependency is reused, not duplicated', async () => {
    // patient_demographics was materialized on csv by the cascade above; a new
    // dependent must reuse it rather than create a second one.
    const before = await searchOne(LEAF, 'csv')
    const res = await postMV({
      view: 'http://myig.org/Library/empty-result-view',
      destination: 'csv',
      name: 'empty_csv',
    })
    expect(res.status).toBe(201)
    const after = await searchOne(LEAF, 'csv')
    expect(after.total).toBe(before.total) // reused; no new leaf materialization
  })

  test('a dependency cycle is rejected', async () => {
    const res = await postMV({
      view: 'http://myig.org/Library/cycle-view-a',
      destination: 'csv',
      name: 'cyc',
    })
    expect(res.status).toBe(422)
  })

  test('the New-form fields fragment derives the name and previews dependencies', async () => {
    const url = new URL(`${base}/MaterializedView/new/fields`)
    url.searchParams.set('view', 'http://myig.org/Library/female-demographics-view')
    url.searchParams.set('destination', 'sqlite')
    const html = await (await fetch(url)).text()
    // Name derived from the view.
    expect(html).toContain('value="female_demographics_view"')
    // The logical dependency is previewed with its cascade state.
    expect(html).toContain('patient-demographics-view')
    expect(html).toMatch(/will be materialized|already materialized/)
  })
})

// Post a ViewDefinition through the create endpoint, returning its canonical url.
async function postView(vd) {
  const res = await fetch(`${base}/ViewDefinition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/json' },
    body: JSON.stringify(vd),
  })
  return res.json()
}

describe('correctness fixes (review follow-up)', () => {
  test('read handler responds (does not hang) when the relation table is gone (#1)', async () => {
    const mv = await (
      await postMV({
        view: 'http://myig.org/ViewDefinition/patient_multiple_birth',
        destination: 'sqlite',
        name: 'guard_rel',
      })
    ).json()
    expect(mv.status).toBe('ready')

    // Drop the underlying relation out-of-band, simulating a partial/failed build.
    const db = new Database(DB_PATH)
    db.exec('PRAGMA busy_timeout = 5000')
    db.run('DROP TABLE IF EXISTS "mv_sqlite_guard_rel"')
    db.close()

    // Must return an error response, not hang until the test times out.
    const res = await fetch(`${base}/MaterializedView/${mv.id}/$data`)
    expect(res.status).toBeGreaterThanOrEqual(500)
    const oo = await res.json()
    expect(oo.resourceType).toBe('OperationOutcome')
  })

  test('column names with a double-quote are handled, not injected (#4)', async () => {
    const vd = await postView({
      resourceType: 'ViewDefinition',
      name: 'weird_cols_view',
      resource: 'Patient',
      status: 'draft',
      select: [
        {
          column: [
            { name: 'id', path: 'getResourceKey()', type: 'id' },
            { name: 'we"ird', path: 'gender', type: 'code' },
          ],
        },
      ],
    })
    const res = await postMV({ view: vd.url, destination: 'sqlite', name: 'weird_cols' })
    expect(res.status).toBe(201) // no 500 from broken DDL
    const data = await (
      await fetch(`${base}/ViewDefinition/${vd.id}/$run?destination=sqlite&format=json`)
    ).json()
    expect(Object.keys(data[0])).toContain('we"ird')
  })

  test('run-by-destination resolves a typed ViewDefinition/<id> registration (#5)', async () => {
    // Registered by typed ref (not bare id); $run must still find it.
    const res = await postMV({
      view: 'ViewDefinition/patient_multiple_birth',
      destination: 'csv',
      name: 'pmb_typed',
    })
    expect(res.status).toBe(201)
    const run = await fetch(`${base}/ViewDefinition/patient_multiple_birth/$run?destination=csv&format=json`)
    expect(run.status).toBe(200)
    expect(Array.isArray(await run.json())).toBe(true)
  })
})
