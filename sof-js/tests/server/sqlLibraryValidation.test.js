/**
 * Unit tests for the pure SQL Library validation core.
 *
 * These tests cover validateSqlLibraryShape (no I/O) and the advisory
 * dependency resolution in validateSqlLibrary (via a lightweight stub config).
 *
 * Author: John Grimes
 */

import { validateSqlLibraryShape, validateSqlLibrary } from '../../src/server/sqlLibraryValidation.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal conformant SQLQuery Library fixture.
 *
 * @returns {object} a conformant sql-query Library.
 */
function conformantSqlQuery() {
  return {
    resourceType: 'Library',
    id: 'test-query',
    status: 'active',
    type: {
      coding: [{ system: 'https://sql-on-fhir.org/ig/CodeSystem/LibraryTypesCodes', code: 'sql-query' }],
    },
    relatedArtifact: [
      {
        type: 'depends-on',
        resource: 'http://example.org/ViewDefinition/patient_demographics',
        label: 'patient_demographics',
      },
    ],
    content: [
      {
        contentType: 'application/sql',
        extension: [
          {
            url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
            valueString: 'SELECT COUNT(*) AS total FROM patient_demographics',
          },
        ],
      },
    ],
  }
}

/**
 * Build a minimal conformant SQLView Library fixture.
 *
 * @returns {object} a conformant sql-view Library.
 */
function conformantSqlView() {
  return {
    resourceType: 'Library',
    id: 'test-view',
    status: 'active',
    type: {
      coding: [{ system: 'https://sql-on-fhir.org/ig/CodeSystem/LibraryTypesCodes', code: 'sql-view' }],
    },
    relatedArtifact: [
      {
        type: 'depends-on',
        resource: 'http://example.org/ViewDefinition/patient_demographics',
        label: 'patient_demographics',
      },
    ],
    content: [
      {
        contentType: 'application/sql',
        extension: [
          {
            url: 'https://sql-on-fhir.org/ig/StructureDefinition/sql-text',
            valueString: 'SELECT id, gender FROM patient_demographics',
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// validateSqlLibraryShape - pure checks
// ---------------------------------------------------------------------------

describe('validateSqlLibraryShape', () => {
  test('returns no errors for a conformant SQLQuery', () => {
    // A Library that satisfies all shape rules should produce no error issues.
    const issues = validateSqlLibraryShape(conformantSqlQuery())
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('returns no errors for a conformant SQLView', () => {
    // A Library of type sql-view with no parameters should produce no error issues.
    const issues = validateSqlLibraryShape(conformantSqlView())
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('reports an error when type code is neither sql-query nor sql-view', () => {
    // A Library whose type.coding does not contain sql-query or sql-view should
    // produce an error identifying the type element.
    const lib = conformantSqlQuery()
    lib.type = { coding: [{ code: 'logic-library' }] }
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    // The error should point at the type element.
    expect(errors.some((i) => i.expression && i.expression.includes('type'))).toBe(true)
  })

  test('reports an error when type.coding is absent', () => {
    // A Library with no type.coding at all should be flagged.
    const lib = conformantSqlQuery()
    lib.type = {}
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
  })

  test('reports an error when an SQLView declares a parameter', () => {
    // An SQLView must declare zero parameters; one or more should produce an error.
    const lib = conformantSqlView()
    lib.parameter = [{ name: 'gender', use: 'in', type: 'string' }]
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((i) => i.expression && i.expression.includes('parameter'))).toBe(true)
  })

  test('does not report an error when an SQLQuery declares a parameter', () => {
    // Parameters are only forbidden on sql-view, not on sql-query.
    const lib = conformantSqlQuery()
    lib.parameter = [{ name: 'id', use: 'in', type: 'string' }]
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('reports an error when content.contentType does not start with application/sql', () => {
    // Any content entry whose contentType is not an application/sql type should be flagged.
    const lib = conformantSqlQuery()
    lib.content[0].contentType = 'text/plain'
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((i) => i.expression && i.expression.includes('content'))).toBe(true)
  })

  test('does not error when content.contentType is application/sql;charset=utf-8', () => {
    // The rule is "starts with application/sql", so charset suffixes are allowed.
    const lib = conformantSqlQuery()
    lib.content[0].contentType = 'application/sql;charset=utf-8'
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('reports an error when content has neither data nor a sql-text extension', () => {
    // A content entry with no decodable SQL should produce an error.
    const lib = conformantSqlQuery()
    lib.content[0] = { contentType: 'application/sql' }
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((i) => i.expression && i.expression.includes('content'))).toBe(true)
  })

  test('does not error when content has base64 data and no extension', () => {
    // A content entry with data but no sql-text extension should be accepted.
    const lib = conformantSqlQuery()
    lib.content[0] = {
      contentType: 'application/sql',
      // "SELECT 1" base64-encoded.
      data: Buffer.from('SELECT 1').toString('base64'),
    }
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('reports an error when a relatedArtifact depends-on label is not a valid SQL identifier', () => {
    // Labels like "123bad" or "with spaces" are not valid SQL identifiers.
    const lib = conformantSqlQuery()
    lib.relatedArtifact[0].label = '123-invalid'
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((i) => i.expression && i.expression.includes('relatedArtifact'))).toBe(true)
  })

  test('does not error for a valid SQL identifier label', () => {
    // Underscored and alphanumeric labels beginning with a letter should pass.
    const lib = conformantSqlQuery()
    lib.relatedArtifact[0].label = 'patient_demographics'
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('does not error when there are no relatedArtifact entries', () => {
    // A Library with no dependencies is valid from a shape perspective.
    const lib = conformantSqlQuery()
    delete lib.relatedArtifact
    const issues = validateSqlLibraryShape(lib)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// validateSqlLibrary - advisory dependency resolution with a stub config
// ---------------------------------------------------------------------------

/**
 * Build a stub config whose search() returns viewDefs and libraries as given.
 *
 * @param {object[]} viewDefs - ViewDefinition resources to return from search.
 * @param {object[]} libraries - Library resources to return from search.
 * @returns {object} stub config object suitable for validateSqlLibrary.
 */
function stubConfig({ viewDefs = [], libraries = [] } = {}) {
  return {
    search: async (_config, resourceType) => {
      if (resourceType === 'ViewDefinition') return viewDefs
      if (resourceType === 'Library') return libraries
      return []
    },
  }
}

describe('validateSqlLibrary - advisory dependency resolution', () => {
  test('returns no errors for a conformant SQLQuery with a resolvable ViewDefinition dependency', async () => {
    // When the dependency resolves to a ViewDefinition, no error should be raised.
    const viewDef = {
      id: 'patient_demographics',
      url: 'http://example.org/ViewDefinition/patient_demographics',
    }
    const config = stubConfig({ viewDefs: [viewDef] })
    const lib = conformantSqlQuery()
    const issues = await validateSqlLibrary(lib, config)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('returns an error when a dependency resolves to an sql-query Library', async () => {
    // A dependency that is itself an sql-query is not permitted - only sql-view is.
    const lib = conformantSqlQuery()
    lib.relatedArtifact[0].resource = 'http://example.org/Library/other-query'
    const badLib = {
      id: 'other-query',
      url: 'http://example.org/Library/other-query',
      type: { coding: [{ code: 'sql-query' }] },
    }
    const config = stubConfig({ viewDefs: [], libraries: [badLib] })
    const issues = await validateSqlLibrary(lib, config)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((i) => i.diagnostics && i.diagnostics.includes('sql-query'))).toBe(true)
  })

  test('returns a warning (not error) when a dependency canonical cannot be resolved', async () => {
    // An unresolvable dependency should yield a warning so existing queries that
    // reference missing resources are not hard-rejected.
    const lib = conformantSqlQuery()
    lib.relatedArtifact[0].resource = 'http://example.org/ViewDefinition/does_not_exist'
    const config = stubConfig({ viewDefs: [], libraries: [] })
    const issues = await validateSqlLibrary(lib, config)
    const errors = issues.filter((i) => i.severity === 'error')
    const warnings = issues.filter((i) => i.severity === 'warning')
    expect(errors).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
  })

  test('returns no errors for a conformant SQLView with a resolvable ViewDefinition dependency', async () => {
    // A conformant sql-view with a ViewDefinition dependency should produce no errors.
    const viewDef = {
      id: 'patient_demographics',
      url: 'http://example.org/ViewDefinition/patient_demographics',
    }
    const config = stubConfig({ viewDefs: [viewDef] })
    const lib = conformantSqlView()
    const issues = await validateSqlLibrary(lib, config)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  test('returns an error when a dependency resolves to a Library with parameters', async () => {
    // A dependency Library that declares parameters is not a valid sql-view target.
    const lib = conformantSqlQuery()
    lib.relatedArtifact[0].resource = 'http://example.org/Library/param-view'
    const paramView = {
      id: 'param-view',
      url: 'http://example.org/Library/param-view',
      type: { coding: [{ code: 'sql-view' }] },
      parameter: [{ name: 'gender', use: 'in', type: 'string' }],
    }
    const config = stubConfig({ viewDefs: [], libraries: [paramView] })
    const issues = await validateSqlLibrary(lib, config)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
  })

  test('includes shape errors alongside resolution errors', async () => {
    // Shape errors and resolution errors should both be present in the output.
    const lib = conformantSqlQuery()
    // Make the shape invalid by clearing the type.
    lib.type = { coding: [{ code: 'logic-library' }] }
    lib.relatedArtifact[0].resource = 'http://example.org/ViewDefinition/does_not_exist'
    const config = stubConfig({ viewDefs: [], libraries: [] })
    const issues = await validateSqlLibrary(lib, config)
    // At minimum the wrong-type error and the unresolvable dependency warning
    // should both appear.
    expect(issues.length).toBeGreaterThanOrEqual(2)
  })
})
