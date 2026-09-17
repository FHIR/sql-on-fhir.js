/**
 * Unit tests for the operation plumbing shared by `$sql-run` and
 * `$sql-export`: format negotiation, query-string parameter parsing, artifact
 * classification and the context matching algorithm.
 *
 * Author: John Grimes
 */

import {
  negotiateFormat,
  representationFor,
  parametersFromQuery,
  artifactKind,
  resolveGraph,
  parseCanonical,
  applySince,
} from '../../src/server/operations.js'
import { sqlQueryLibrary, sqlViewLibrary, patientView } from './helpers.js'

const RUN_FORMATS = ['csv', 'json', 'ndjson', 'fhir']

describe('negotiateFormat', () => {
  test('_format wins over Accept', () => {
    expect(negotiateFormat({ format: 'json', accept: 'text/csv', allowed: RUN_FORMATS })).toBe('json')
  })

  test('Accept selects a format when _format is absent', () => {
    expect(negotiateFormat({ format: null, accept: 'text/csv', allowed: RUN_FORMATS })).toBe('csv')
    expect(negotiateFormat({ format: null, accept: 'application/json', allowed: RUN_FORMATS })).toBe('json')
    expect(negotiateFormat({ format: null, accept: 'application/x-ndjson', allowed: RUN_FORMATS })).toBe(
      'ndjson',
    )
  })

  test('falls back to ndjson when nothing selects a format', () => {
    expect(negotiateFormat({ format: null, accept: '*/*', allowed: RUN_FORMATS })).toBe('ndjson')
    expect(negotiateFormat({ format: null, accept: undefined, allowed: RUN_FORMATS })).toBe('ndjson')
    // application/fhir+json is a representation, not a format.
    expect(negotiateFormat({ format: null, accept: 'application/fhir+json', allowed: RUN_FORMATS })).toBe(
      'ndjson',
    )
  })

  test('Accept q-values rank the media types', () => {
    expect(
      negotiateFormat({ format: null, accept: 'text/csv;q=0.5, application/json', allowed: RUN_FORMATS }),
    ).toBe('json')
    expect(
      negotiateFormat({ format: null, accept: 'text/csv;q=0, application/x-ndjson', allowed: RUN_FORMATS }),
    ).toBe('ndjson')
  })

  test('export ignores Accept entirely', () => {
    expect(
      negotiateFormat({
        format: null,
        accept: 'text/csv',
        allowed: ['csv', 'json', 'ndjson'],
        useAccept: false,
      }),
    ).toBe('ndjson')
  })

  test('an unknown or unsupported format is rejected with not-supported', () => {
    expect(() => negotiateFormat({ format: 'parquet', accept: null, allowed: RUN_FORMATS })).toThrow(
      expect.objectContaining({ status: 400, issues: [expect.objectContaining({ code: 'not-supported' })] }),
    )
  })
})

describe('representationFor', () => {
  test('raw for no Accept, wildcard, octet-stream and native media types', () => {
    expect(representationFor(undefined)).toBe('raw')
    expect(representationFor('*/*')).toBe('raw')
    expect(representationFor('application/octet-stream')).toBe('raw')
    expect(representationFor('text/csv')).toBe('raw')
  })

  test('FHIR media types select the Binary envelope', () => {
    expect(representationFor('application/fhir+json')).toBe('fhir+json')
    expect(representationFor('application/fhir+xml')).toBe('fhir+xml')
    expect(representationFor('application/fhir+json; fhirVersion=4.0')).toBe('fhir+json')
  })
})

describe('parametersFromQuery', () => {
  const definition = {
    subjectCanonical: { type: 'canonical' },
    subjectReference: { type: 'Reference' },
    subjectResource: { type: 'resource' },
    patient: { type: 'Reference', max: '*' },
    _limit: { type: 'integer' },
    header: { type: 'boolean' },
  }

  test('maps primitives, references and repeats into a Parameters resource', () => {
    const params = parametersFromQuery(
      { subjectCanonical: 'http://x|1', patient: ['Patient/a', 'Patient/b'], _limit: '5', header: 'false' },
      definition,
    )
    expect(params).toEqual({
      resourceType: 'Parameters',
      parameter: [
        { name: 'subjectCanonical', valueCanonical: 'http://x|1' },
        { name: 'patient', valueReference: { reference: 'Patient/a' } },
        { name: 'patient', valueReference: { reference: 'Patient/b' } },
        { name: '_limit', valueInteger: 5 },
        { name: 'header', valueBoolean: false },
      ],
    })
  })

  test('a resource-carrying parameter over GET is 400 invalid naming it', () => {
    expect(() => parametersFromQuery({ subjectResource: '{}' }, definition)).toThrow(
      expect.objectContaining({
        status: 400,
        issues: [expect.objectContaining({ code: 'invalid', expression: ['subjectResource'] })],
      }),
    )
  })

  test('a non-integer _limit is 400 invalid', () => {
    expect(() => parametersFromQuery({ _limit: 'ten' }, definition)).toThrow(
      expect.objectContaining({ status: 400 }),
    )
  })
})

describe('artifactKind', () => {
  test('classifies the three artifact kinds and rejects anything else', () => {
    expect(artifactKind(patientView())).toBe('ViewDefinition')
    expect(artifactKind(sqlQueryLibrary('SELECT 1', []))).toBe('SQLQuery')
    expect(artifactKind(sqlViewLibrary('http://v', 'SELECT 1', []))).toBe('SQLView')
    expect(
      artifactKind({ resourceType: 'Library', type: { coding: [{ code: 'logic-library' }] } }),
    ).toBeNull()
    expect(artifactKind({ resourceType: 'Patient' })).toBeNull()
  })
})

describe('parseCanonical', () => {
  test('splits an optional version suffix', () => {
    expect(parseCanonical('http://x/y')).toEqual({ url: 'http://x/y', version: null })
    expect(parseCanonical('http://x/y|2.0.0')).toEqual({ url: 'http://x/y', version: '2.0.0' })
  })
})

describe('resolveGraph', () => {
  const V = 'https://example.org/ViewDefinition/v'
  const W = 'https://example.org/ViewDefinition/w'
  const SV = 'https://example.org/Library/sv'
  const stored = {
    [V]: { kind: 'ViewDefinition', resource: patientView(V) },
  }
  const lookup = async (url) => stored[url] || null

  test('resolves server artifacts and records one resolution per url', async () => {
    const a = sqlQueryLibrary('SELECT 1', [{ resource: V, label: 'a' }])
    const b = sqlQueryLibrary('SELECT 1', [{ resource: V, label: 'b' }])
    const graph = await resolveGraph({ subjects: [a, b], context: [], lookup })
    expect(graph.size).toBe(1)
    expect(graph.get(V).kind).toBe('ViewDefinition')
  })

  test('a context entry takes precedence over a stored artifact', async () => {
    const supplied = patientView(V)
    supplied.name = 'supplied'
    const q = sqlQueryLibrary('SELECT 1', [{ resource: V, label: 'a' }])
    const graph = await resolveGraph({ subjects: [q], context: [supplied], lookup })
    expect(graph.get(V).resource.name).toBe('supplied')
  })

  test('traverses through a supplied SQLView so its own dependencies are matched', async () => {
    const q = sqlQueryLibrary('SELECT 1', [{ resource: SV, label: 's' }])
    const sv = sqlViewLibrary(SV, 'SELECT 1', [{ resource: W, label: 'w' }])
    const graph = await resolveGraph({ subjects: [q], context: [sv, patientView(W)], lookup })
    expect([...graph.keys()].sort()).toEqual([SV, W].sort())
  })

  test('a version-pinned dependency matches only an entry with that version', async () => {
    const q = sqlQueryLibrary('SELECT 1', [{ resource: `${W}|2.0.0`, label: 'w' }])
    const wrong = patientView(W)
    wrong.version = '1.0.0'
    // The entry with the wrong version matches nothing, which is reported as the
    // mistake (400 naming context) with the unresolved dependency alongside.
    await expect(resolveGraph({ subjects: [q], context: [wrong], lookup })).rejects.toMatchObject({
      status: 400,
      issues: [
        expect.objectContaining({ code: 'invalid', expression: ['context'] }),
        expect.objectContaining({ code: 'not-found', diagnostics: expect.stringContaining(`${W}|2.0.0`) }),
      ],
    })
    const right = patientView(W)
    right.version = '2.0.0'
    const graph = await resolveGraph({ subjects: [q], context: [right], lookup })
    expect(graph.get(`${W}|2.0.0`).resource.version).toBe('2.0.0')
  })

  test('an unresolvable dependency is 404 naming the canonical', async () => {
    const q = sqlQueryLibrary('SELECT 1', [{ resource: W, label: 'w' }])
    await expect(resolveGraph({ subjects: [q], context: [], lookup })).rejects.toMatchObject({
      status: 404,
      issues: [expect.objectContaining({ code: 'not-found', diagnostics: expect.stringContaining(W) })],
    })
  })

  test('an unmatched, url-less or duplicate context entry is 400 naming context', async () => {
    const q = sqlQueryLibrary('SELECT 1', [{ resource: V, label: 'v' }])
    const expect400 = (context) =>
      expect(resolveGraph({ subjects: [q], context, lookup })).rejects.toMatchObject({
        status: 400,
        issues: [expect.objectContaining({ code: 'invalid', expression: ['context'] })],
      })
    await expect400([patientView(W)])
    await expect400([patientView()])
    await expect400([patientView(V), patientView(V)])
  })

  test('a ViewDefinition subject contributes no dependencies', async () => {
    const graph = await resolveGraph({ subjects: [patientView()], context: [], lookup })
    expect(graph.size).toBe(0)
  })

  test('a dependency that is neither stored nor a context entry is resolved as a ValueSet', async () => {
    const VS = 'https://example.org/ValueSet/vs|1'
    const q = sqlQueryLibrary('SELECT 1', [{ resource: VS, label: 'vs' }])
    const record = { canonical: VS, rows: [], parameters: [] }
    const seen = []
    const lookupValueSet = async (canonical) => {
      seen.push(canonical)
      return record
    }
    const graph = await resolveGraph({ subjects: [q], context: [], lookup, lookupValueSet })
    // The canonical is passed as written, version pin included.
    expect(seen).toEqual([VS])
    expect(graph.get(VS)).toEqual({ kind: 'ValueSet', resource: record })
  })

  test('a value set unknown to the terminology server is 404 naming the canonical', async () => {
    const q = sqlQueryLibrary('SELECT 1', [{ resource: W, label: 'w' }])
    const lookupValueSet = async () => {
      const err = new Error('nobody has heard of it')
      err.status = 404
      throw err
    }
    await expect(resolveGraph({ subjects: [q], context: [], lookup, lookupValueSet })).rejects.toMatchObject({
      status: 404,
      issues: [expect.objectContaining({ code: 'not-found', diagnostics: expect.stringContaining(W) })],
    })
  })

  test('a value set whose membership cannot be determined fails the graph with 422', async () => {
    const q = sqlQueryLibrary('SELECT 1', [{ resource: W, label: 'w' }])
    const lookupValueSet = async () => {
      const err = new Error('server on fire')
      err.status = 422
      throw err
    }
    await expect(resolveGraph({ subjects: [q], context: [], lookup, lookupValueSet })).rejects.toMatchObject({
      status: 422,
    })
  })
})

describe('applySince', () => {
  test('keeps resources updated after the instant and those without lastUpdated', () => {
    const resources = [
      { id: 'old', meta: { lastUpdated: '2020-01-01T00:00:00Z' } },
      { id: 'new', meta: { lastUpdated: '2026-01-01T00:00:00Z' } },
      { id: 'undated' },
    ]
    expect(applySince(resources, '2025-01-01T00:00:00Z').map((r) => r.id)).toEqual(['new', 'undated'])
    expect(applySince(resources, null)).toBe(resources)
  })
})
