/**
 * Integration tests for the POST /ViewDefinition/$validate endpoint.
 *
 * These tests verify the fix for the pre-existing bug where the endpoint
 * called req.body.json() (incorrect under Express, where req.body is already
 * parsed) and echoed the resource back without validating it.  After the fix
 * the endpoint validates the posted ViewDefinition and returns an
 * OperationOutcome consistent with the Library $validate endpoint.
 *
 * @author John Grimes
 */

import { startServer } from '../../src/server.js'

let server
const port = 3005
const base = `http://localhost:${port}`

beforeAll(async () => {
  server = await startServer({ port })
  console.log('Server started')
}, 30000)

afterAll(async () => {
  server?.close()
  console.log('Server stopped')
})

describe('POST /ViewDefinition/$validate', () => {
  test('returns OperationOutcome with no errors for a valid ViewDefinition', async () => {
    // A well-formed ViewDefinition should produce an OperationOutcome with no
    // error-severity issues.
    const viewDefinition = {
      resourceType: 'ViewDefinition',
      name: 'patient_demographics',
      resource: 'Patient',
      select: [
        {
          column: [
            { path: 'getResourceKey()', name: 'id', type: 'id' },
            { path: 'name.given.first()', name: 'given', type: 'string' },
          ],
        },
      ],
    }
    const res = await fetch(`${base}/ViewDefinition/$validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(viewDefinition),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(Array.isArray(body.issue)).toBe(true)
    const errors = body.issue.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('returns OperationOutcome with error issues for an invalid ViewDefinition', async () => {
    // A ViewDefinition missing required fields should produce error issues.
    const invalidViewDefinition = {
      resourceType: 'ViewDefinition',
      name: 'broken',
      resource: 'Patient',
      select: [
        {
          // Missing required column or forEach fields.
          column: [{ path: 'name.given.first()', name: 'given' }],
        },
      ],
    }
    const res = await fetch(`${base}/ViewDefinition/$validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(invalidViewDefinition),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resourceType).toBe('OperationOutcome')
    expect(Array.isArray(body.issue)).toBe(true)
    const errors = body.issue.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
  })

  test('Content-Type response header is application/fhir+json', async () => {
    // The endpoint must set the FHIR content type on its response.
    const viewDefinition = {
      resourceType: 'ViewDefinition',
      name: 'test',
      resource: 'Patient',
      select: [{ column: [{ path: 'id', name: 'id', type: 'id' }] }],
    }
    const res = await fetch(`${base}/ViewDefinition/$validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(viewDefinition),
    })
    expect(res.headers.get('Content-Type')).toContain('application/fhir+json')
  })
})
