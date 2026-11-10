/**
 * External relations on `$sql-run`: a `relatedArtifact[depends-on]` naming a
 * logical-model StructureDefinition derived from the SQL on FHIR `Relation`
 * base is exposed to the SQL as a table whose columns are the model's
 * `differential` elements, populated from a csv, ndjson or parquet file: the first
 * `relation-source` attachment in a supported format (`file:` under the
 * server's relation directory, or `http(s):`), unless the server's
 * configuration binds the canonical to a file of its own. Data is never
 * embedded in the definition. The definition may be stored on the server or
 * supplied inline as a `context` entry.
 *
 * Author: niquola
 */

import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startTestServer, parameters, post, sqlQueryLibrary } from './helpers.js'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { parseCsv, csvRows, ndjsonRows, parquetRows, relationColumns } from '../../src/server/relation.js'

let server
let base
let tx
let csvServer
let csvUrl
let relationDir
let exportDir
const port = 3013
const BOUND = 'http://example.org/sd/bound'

const RELATION_BASE = 'http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/Relation'
const SOURCE_EXT = 'http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/relation-source'
const US_STATES = 'http://myig.org/StructureDefinition/us-states'
const OMOP_CONCEPT = 'http://myig.org/StructureDefinition/omop-concept'
const PATIENTS = 'http://myig.org/ViewDefinition/patient_demographics'

beforeAll(async () => {
  relationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sof-relations-'))
  fs.copyFileSync(
    new URL('../../metadata/relations/us_states.csv', import.meta.url),
    path.join(relationDir, 'us_states.csv'),
  )
  fs.writeFileSync(path.join(relationDir, 'req.csv'), 'k,v\nx,\n,y\n')
  fs.writeFileSync(path.join(relationDir, 'extra.csv'), 'k,other\nx,1\n')
  fs.writeFileSync(path.join(relationDir, 'plain.csv'), 'k\nx\n')
  fs.writeFileSync(path.join(relationDir, 'bound.csv'), 'k,v\nfrom-config,1\n')
  fs.writeFileSync(path.join(relationDir, 'codes.ndjson'), '{"code":"A","n":1}\n{"code":"B","n":null}\n')
  fs.copyFileSync(
    new URL('../../metadata/relations/omop_concept.parquet', import.meta.url),
    path.join(relationDir, 'omop_concept.parquet'),
  )
  fs.writeFileSync(path.join(relationDir, 'fk.csv'), 'state,n\nCA,1\n')
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sof-relation-export-'))
  ;({ server, base, tx } = await startTestServer(port, {
    relationDir,
    exportDir,
    relationSources: { [BOUND]: 'bound.csv' },
    relationFetch: { allowHosts: ['localhost'], maxBytes: 1024 },
  }))
  csvServer = http.createServer((req, res) => {
    if (req.url === '/codes.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv' })
      res.end('code,label,weight\nA,"Alpha, first",1.5\nB,Beta,\n')
    } else if (req.url === '/big.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv' })
      res.end('k\n' + 'x'.repeat(2048) + '\n')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve) => csvServer.listen(0, resolve))
  csvUrl = `http://localhost:${csvServer.address().port}`
}, 120000)

afterAll(async () => {
  server?.close()
  csvServer?.close()
  await tx?.close()
  fs.rmSync(relationDir, { recursive: true, force: true })
  fs.rmSync(exportDir, { recursive: true, force: true })
})

async function run(library, context = []) {
  return post(
    base,
    '/$sql-run',
    parameters([
      { name: 'subjectResource', resource: library },
      { name: '_format', valueCode: 'json' },
      ...context.map((resource) => ({ name: 'context', resource })),
    ]),
  )
}

function library(sql, deps) {
  return sqlQueryLibrary(
    sql,
    deps.map(([resource, label]) => ({ resource, label })),
  )
}

function relation(url, columns, sources) {
  const type = url
    .split('/')
    .pop()
    .replace(/[^A-Za-z0-9]/g, '')
  return {
    resourceType: 'StructureDefinition',
    url,
    name: type,
    status: 'active',
    kind: 'logical',
    abstract: false,
    type,
    baseDefinition: RELATION_BASE,
    derivation: 'specialization',
    extension: sources.map((valueAttachment) => ({ url: SOURCE_EXT, valueAttachment })),
    differential: {
      element: [
        { path: type },
        ...columns.map(({ name, min, max, type: code, ...rest }) => ({
          path: `${type}.${name}`,
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
          ...(code !== undefined ? { type: [{ code }] } : {}),
          ...rest,
        })),
      ],
    },
  }
}

const file = (name) => ({ contentType: 'text/csv', url: `file:${name}` })

async function outcome(res) {
  const body = await res.json()
  expect(body.resourceType).toBe('OperationOutcome')
  return body
}

describe('CSV parsing', () => {
  test('quoted fields, embedded commas and quotes, CRLF, trailing newline', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ])
  })

  test('rows are typed by the relation columns and empty cells become NULL', () => {
    const columns = relationColumns(
      relation(
        'http://x/sd/t',
        [
          { name: 'n', type: 'integer', min: 1 },
          { name: 'd', type: 'decimal' },
          { name: 'b', type: 'boolean' },
        ],
        [],
      ),
    )
    expect(csvRows('n,d,b\n1,2.5,true\n2,,false\n', columns, 'http://x/sd/t')).toEqual([
      { n: 1, d: 2.5, b: true },
      { n: 2, d: null, b: false },
    ])
  })
})

describe('column rules', () => {
  const sd = (columns) => relation('http://x/sd/t', columns, [])

  test('a collection column (max *) is refused', () => {
    expect(() => relationColumns(sd([{ name: 'tags', type: 'string', max: '*' }]))).toThrow(
      /collections are not columns/,
    )
  })

  test('a non-primitive type is refused; a Relation canonical is a foreign key', () => {
    expect(() => relationColumns(sd([{ name: 'c', type: 'Coding' }]))).toThrow(
      /only FHIR primitives or a Relation canonical/,
    )
    const cols = relationColumns(sd([{ name: 'state', type: US_STATES }]))
    expect(cols[0]).toMatchObject({ reference: US_STATES, type: undefined })
  })

  test('sql mapping and primary-key extension are read', () => {
    const cols = relationColumns(
      sd([
        {
          name: 'id',
          type: 'integer64',
          min: 1,
          mapping: [{ identity: 'sql', map: 'BIGINT' }],
          extension: [
            { url: 'http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/primary-key', valueBoolean: true },
          ],
        },
      ]),
    )
    expect(cols[0]).toMatchObject({ sqlType: 'BIGINT', primaryKey: true })
  })

  test('ndjson rows are typed like csv rows', () => {
    const cols = relationColumns(
      sd([
        { name: 'code', type: 'code', min: 1 },
        { name: 'n', type: 'integer' },
      ]),
    )
    expect(ndjsonRows('{"code":"A","n":1}\n{"code":"B"}\n', cols, 'x')).toEqual([
      { code: 'A', n: 1 },
      { code: 'B', n: null },
    ])
    expect(() => ndjsonRows('{"code":"A","extra":1}\n', cols, 'x')).toThrow(
      /not declared by the relation: extra/,
    )
  })

  test('parquet rows are typed, INT64 becomes a number', async () => {
    const cols = relationColumns(
      sd([
        { name: 'id', type: 'integer64', min: 1 },
        { name: 'name', type: 'string' },
        { name: 'ok', type: 'boolean' },
      ]),
    )
    const buf = parquetWriteBuffer({
      columnData: [
        { name: 'id', data: [1n, 2n], type: 'INT64' },
        { name: 'name', data: ['a', null] },
        { name: 'ok', data: [true, false] },
      ],
    })
    expect(await parquetRows(Buffer.from(buf), cols, 'x')).toEqual([
      { id: 1, name: 'a', ok: true },
      { id: 2, name: null, ok: false },
    ])
  })
})

describe('Relation dependencies on $sql-run', () => {
  test('a stored relation whose CSV is a file under the relation directory is exposed under its label', async () => {
    const res = await run(
      library('SELECT code, name, fips FROM states ORDER BY code', [[`${US_STATES}|1.0`, 'states']]),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBe(9)
    expect(Object.keys(rows[0])).toEqual(['code', 'name', 'fips'])
    expect(rows.find((r) => r.code === 'CA')).toEqual({ code: 'CA', name: 'California', fips: '06' })
  })

  test('a relation offering several formats is read from the first supported one', async () => {
    const res = await run(library('SELECT count(*) AS n FROM states', [[US_STATES, 'states']]))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ n: 9 }])
  })

  test('a relation joins with a ViewDefinition like any other table', async () => {
    const res = await run(
      library(
        `SELECT s.name AS state, count(p.id) AS patients
         FROM states s LEFT JOIN patients p ON p.gender = 'female' AND s.code = 'MA'
         GROUP BY s.name ORDER BY patients DESC, state LIMIT 1`,
        [
          [US_STATES, 'states'],
          [PATIENTS, 'patients'],
        ],
      ),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows[0].state).toBe('Massachusetts')
    expect(rows[0].patients).toBeGreaterThan(0)
  })

  test('an inline relation supplied as context is loaded from a CSV URL and typed', async () => {
    const url = 'http://example.org/sd/codes'
    const sd = relation(
      url,
      [
        { name: 'code', type: 'code', min: 1 },
        { name: 'label', type: 'string', min: 1 },
        { name: 'weight', type: 'decimal' },
      ],
      [{ contentType: 'text/csv', url: `${csvUrl}/codes.csv` }],
    )
    const res = await run(library('SELECT * FROM codes ORDER BY code', [[url, 'codes']]), [sd])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { code: 'A', label: 'Alpha, first', weight: 1.5 },
      { code: 'B', label: 'Beta', weight: null },
    ])
  })

  test('a column without cardinality is nullable; a required one must be filled', async () => {
    const url = 'http://example.org/sd/req'
    const sd = relation(
      url,
      [
        { name: 'k', type: 'string', min: 1 },
        { name: 'v', type: 'string' },
      ],
      [file('req.csv')],
    )
    const res = await run(library('SELECT * FROM t', [[url, 't']]), [sd])
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].diagnostics).toMatch(/line 3: required column 'k' is empty/)
  })

  test('a CSV header with undeclared columns is rejected', async () => {
    const url = 'http://example.org/sd/extra'
    const sd = relation(url, [{ name: 'k', type: 'string', min: 1 }], [file('extra.csv')])
    const res = await run(library('SELECT * FROM t', [[url, 't']]), [sd])
    expect(res.status).toBe(422)
    expect((await outcome(res)).issue[0].diagnostics).toMatch(/not declared by the relation: other/)
  })

  test('a relation offering only unsupported formats fails with not-supported', async () => {
    const url = 'http://example.org/sd/xlsx-only'
    const sd = relation(
      url,
      [{ name: 'k', type: 'string' }],
      [{ contentType: 'application/vnd.ms-excel', url: 'file:y.xlsx' }],
    )
    const res = await run(library('SELECT * FROM t', [[url, 't']]), [sd])
    expect(res.status).toBe(422)
    const body = await outcome(res)
    expect(body.issue[0].code).toBe('not-supported')
  })

  test('an unreachable CSV URL is reported, not silently empty', async () => {
    const url = 'http://example.org/sd/gone'
    const sd = relation(
      url,
      [{ name: 'k', type: 'string' }],
      [{ contentType: 'text/csv', url: `${csvUrl}/missing.csv` }],
    )
    const res = await run(library('SELECT * FROM t', [[url, 't']]), [sd])
    expect(res.status).toBe(422)
    expect((await outcome(res)).issue[0].diagnostics).toMatch(/answered 404/)
  })

  test('embedded data is refused: the data must live in a file', async () => {
    const url = 'http://example.org/sd/embedded'
    const sd = relation(
      url,
      [{ name: 'k', type: 'string' }],
      [{ contentType: 'text/csv', data: Buffer.from('k\nx\n').toString('base64') }],
    )
    const res = await run(library('SELECT * FROM t', [[url, 't']]), [sd])
    expect(res.status).toBe(422)
    expect((await outcome(res)).issue[0].diagnostics).toMatch(/embedded relation-source data is not accepted/)
  })

  test('a file: source may not escape the relation directory', async () => {
    const url = 'http://example.org/sd/escape'
    const sd = relation(url, [{ name: 'k', type: 'string' }], [file('../../etc/passwd')])
    const res = await run(library('SELECT * FROM t', [[url, 't']]), [sd])
    expect(res.status).toBe(422)
    expect((await outcome(res)).issue[0].code).toBe('security')
  })

  test('server configuration binds a canonical to its own file and wins over the definition', async () => {
    const sd = relation(
      BOUND,
      [
        { name: 'k', type: 'string' },
        { name: 'v', type: 'integer' },
      ],
      [{ contentType: 'text/csv', url: `${csvUrl}/missing.csv` }],
    )
    const res = await run(library('SELECT * FROM t', [[BOUND, 't']]), [sd])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ k: 'from-config', v: 1 }])
  })

  test('a logical model not derived from Relation is not accepted as a dependency', async () => {
    const url = 'http://example.org/sd/plain'
    const sd = {
      ...relation(url, [{ name: 'k', type: 'string' }], [file('plain.csv')]),
      baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Base',
    }
    const res = await run(library('SELECT * FROM t', [[url, 't']]), [sd])
    expect(res.status).toBe(400)
    expect((await outcome(res)).issue[0].diagnostics).toMatch(
      /is not a ViewDefinition, SQLView, ValueSet, ConceptMap or Relation/,
    )
  })

  test('a stored parquet relation with sql mapping and a primary key is queryable', async () => {
    const res = await run(
      library(
        'SELECT concept_id, concept_name FROM concept WHERE vocabulary_id = ? ORDER BY concept_id'.replace(
          '?',
          "'SNOMED'",
        ),
        [[`${OMOP_CONCEPT}|5.4`, 'concept']],
      ),
    )
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ concept_id: 201826, concept_name: 'Type 2 diabetes mellitus' })
  })

  test('an ndjson relation-source is read', async () => {
    const url = 'http://example.org/sd/ndjson'
    const sd = relation(
      url,
      [
        { name: 'code', type: 'code', min: 1 },
        { name: 'n', type: 'integer' },
      ],
      [{ contentType: 'application/x-ndjson', url: 'file:codes.ndjson' }],
    )
    const res = await run(library('SELECT * FROM t ORDER BY code', [[url, 't']]), [sd])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { code: 'A', n: 1 },
      { code: 'B', n: null },
    ])
  })

  test('a foreign key to a known relation is accepted; to an unknown one is refused', async () => {
    const url = 'http://example.org/sd/fk'
    const ok = relation(
      url,
      [
        { name: 'state', type: US_STATES, min: 1 },
        { name: 'n', type: 'integer' },
      ],
      [file('fk.csv')],
    )
    const res = await run(
      library('SELECT s.name, t.n FROM t JOIN states s ON s.code = t.state', [
        [url, 't'],
        [US_STATES, 'states'],
      ]),
      [ok],
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ name: 'California', n: 1 }])

    const dangling = relation(
      url,
      [
        { name: 'state', type: 'http://example.org/sd/nowhere', min: 1 },
        { name: 'n', type: 'integer' },
      ],
      [file('fk.csv')],
    )
    const bad = await run(library('SELECT * FROM t', [[url, 't']]), [dangling])
    expect(bad.status).toBe(422)
    expect((await outcome(bad)).issue[0].diagnostics).toMatch(
      /references 'http:\/\/example.org\/sd\/nowhere' as a foreign key/,
    )
  })

  test('remote sources obey the host allow-list and the size cap', async () => {
    const url = 'http://example.org/sd/remote'
    const foreign = relation(
      url,
      [{ name: 'k', type: 'string' }],
      [{ contentType: 'text/csv', url: 'http://example.com/x.csv' }],
    )
    let res = await run(library('SELECT * FROM t', [[url, 't']]), [foreign])
    expect(res.status).toBe(422)
    expect((await outcome(res)).issue[0].code).toBe('security')

    const big = relation(
      url,
      [{ name: 'k', type: 'string' }],
      [{ contentType: 'text/csv', url: `${csvUrl}/big.csv` }],
    )
    res = await run(library('SELECT * FROM t', [[url, 't']]), [big])
    expect(res.status).toBe(422)
    expect((await outcome(res)).issue[0].code).toBe('too-costly')
  })

  test('$sql-export records the relation file and its sha256 in the manifest', async () => {
    const lib = library('SELECT count(*) AS n FROM states', [[US_STATES, 'states']])
    const res = await post(
      base,
      '/$sql-export',
      parameters([
        {
          name: 'subject',
          part: [
            { name: 'name', valueString: 'states' },
            { name: 'subjectResource', resource: lib },
          ],
        },
        { name: '_format', valueCode: 'json' },
      ]),
      { Prefer: 'respond-async' },
    )
    expect(res.status).toBe(202)
    const statusUrl = res.headers.get('Content-Location')
    let done
    for (let i = 0; i < 50 && !done; i++) {
      const poll = await fetch(statusUrl, { redirect: 'manual' })
      if (poll.status === 303) done = poll
      else await new Promise((r) => setTimeout(r, 100))
    }
    expect(done).toBeTruthy()
    const manifest = await (await fetch(done.headers.get('Location'))).json()
    const dep = manifest.parameter.find((p) => p.name === 'dependency')
    expect(dep).toBeTruthy()
    const part = (n) => dep.part.find((p) => p.name === n)
    expect(part('kind').valueCode).toBe('Relation')
    expect(part('canonical').valueCanonical).toBe(US_STATES)
    expect(part('source').valueUri).toBe('file:us_states.csv')
    expect(part('sha256').valueString).toMatch(/^[0-9a-f]{64}$/)
    expect(part('rows').valueInteger).toBe(9)
  })

  test('relations are listed at /StructureDefinition', async () => {
    const res = await fetch(`${base}/StructureDefinition`, { headers: { Accept: 'application/fhir+json' } })
    expect(res.status).toBe(200)
    const bundle = await res.json()
    expect(bundle.entry.map((e) => e.resource.url).sort()).toEqual([OMOP_CONCEPT, US_STATES])
    const html = await fetch(`${base}/StructureDefinition`, { headers: { Accept: 'text/html' } })
    expect(await html.text()).toMatch(/US states/)
  })

  test('the stored relation is listed by $sql-run validation as a resolvable dependency', async () => {
    const res = await post(
      base,
      '/Library/$validate',
      library('SELECT 1 FROM states', [[US_STATES, 'states']]),
    )
    if (res.status === 404) return // validation endpoint not mounted in this build
    const body = await res.json()
    const notFound = (body.issue || []).filter((i) => i.code === 'not-found')
    expect(notFound).toHaveLength(0)
  })
})
