/**
 * HTTP-level tests for views that call `memberOf`, which the server evaluates
 * against its configured terminology server (`terminologyServerUrl`).
 *
 * Author: John Grimes
 */

import { startTestServer, parameters, post, sqlQueryLibrary, KNOWN_PATIENTS } from './helpers.js'
import { startFixtureTerminologyServer } from '../fixtureTerminologyServer.js'

const LOINC = 'http://loinc.org'
const HEART_RATE = 'http://example.org/ValueSet/heart-rate'

let server
let base
let tx
let terminology
const port = 3013

beforeAll(async () => {
  // A value set with the single member LOINC 8867-4 (Heart rate).
  terminology = await startFixtureTerminologyServer({
    server: [
      {
        resourceType: 'ValueSet',
        url: HEART_RATE,
        status: 'active',
        expansion: { timestamp: '2024-01-01T00:00:00Z', contains: [{ system: LOINC, code: '8867-4' }] },
      },
    ],
  })
  ;({ server, base, tx } = await startTestServer(port, {
    terminologyServerUrl: terminology.urlFor('server'),
  }))
}, 120000)

afterAll(async () => {
  server?.close()
  await tx?.close()
  await terminology?.close()
})

const VIEW_URL = 'http://example.org/ViewDefinition/heart-rate-observations'

// One row per Observation, with its first LOINC code and whether its code is
// in the heart rate value set.
const heartRateView = {
  resourceType: 'ViewDefinition',
  url: VIEW_URL,
  status: 'active',
  resource: 'Observation',
  select: [
    {
      column: [
        { name: 'id', path: 'getResourceKey()', type: 'id' },
        { name: 'code', path: `code.coding.where(system = '${LOINC}').code.first()`, type: 'code' },
        { name: 'is_heart_rate', path: `code.memberOf('${HEART_RATE}')`, type: 'boolean' },
      ],
    },
  ],
}

function observation(id, code) {
  return { resourceType: 'Observation', id, status: 'final', code: { coding: [{ system: LOINC, code }] } }
}

describe('memberOf on the server', () => {
  test('$sql-run on a ViewDefinition resolves memberOf against the terminology server', async () => {
    // Arrange: two inline Observations, one of them a heart rate.
    const body = parameters([
      { name: 'subjectResource', resource: heartRateView },
      { name: 'resource', resource: observation('hr', '8867-4') },
      { name: 'resource', resource: observation('glucose', '2339-0') },
      { name: '_format', valueCode: 'json' },
    ])

    // Act
    const res = await post(base, '/$sql-run', body)

    // Assert: membership comes from the fixture value set.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { id: 'hr', code: '8867-4', is_heart_rate: true },
      { id: 'glucose', code: '2339-0', is_heart_rate: false },
    ])
  })

  test('$sql-run on a SQLQuery evaluates a memberOf ViewDefinition dependency', async () => {
    // Arrange: a query over the view, run against one Synthea patient's
    // stored Observations.
    const library = sqlQueryLibrary('SELECT code, is_heart_rate FROM obs', [
      { resource: VIEW_URL, label: 'obs' },
    ])
    const body = parameters([
      { name: 'subjectResource', resource: library },
      { name: 'context', resource: heartRateView },
      { name: 'patient', valueReference: { reference: `Patient/${KNOWN_PATIENTS[0]}` } },
      { name: '_format', valueCode: 'json' },
    ])

    // Act
    const res = await post(base, '/$sql-run', body)

    // Assert: a row is a member exactly when its code is 8867-4, and the
    // patient has at least one heart rate observation.
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.some((r) => r.code === '8867-4')).toBe(true)
    for (const r of rows) expect(r.is_heart_rate).toBe(r.code === '8867-4')
  })
})
