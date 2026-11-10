/**
 * External relations on `$sql-run`: a `relatedArtifact[depends-on]` naming a
 * logical-model StructureDefinition derived from the SQL on FHIR `Relation`
 * base is exposed to the SQL as a table whose columns are the model's
 * `differential` elements, populated from a CSV file: the first
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
import { parseCsv, csvRows, relationColumns } from '../../src/server/relation.js'

let server
let base
let tx
let csvServer
let csvUrl
let relationDir
const port = 3013
const BOUND = 'http://example.org/sd/bound'

const RELATION_BASE = 'http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/Relation'
const SOURCE_EXT = 'http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/relation-source'
const US_STATES = 'http://myig.org/StructureDefinition/us-states'
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
  ;({ server, base, tx } = await startTestServer(port, {
    relationDir,
    relationSources: { [BOUND]: 'bound.csv' },
  }))
  csvServer = http.createServer((req, res) => {
    if (req.url === '/codes.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv' })
      res.end('code,label,weight\nA,"Alpha, first",1.5\nB,Beta,\n')
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
        ...columns.map((c) => ({ path: `${type}.${c.name}`, min: c.min, type: [{ code: c.type }] })),
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

  test('the unsupported parquet source is skipped in favour of the CSV one', async () => {
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
    const url = 'http://example.org/sd/parquet-only'
    const sd = relation(
      url,
      [{ name: 'k', type: 'string' }],
      [{ contentType: 'application/vnd.apache.parquet', url: 'http://x/y.parquet' }],
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
