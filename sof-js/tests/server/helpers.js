/**
 * Shared helpers for the HTTP-level server tests.
 *
 * Author: John Grimes
 */

import { startServer } from '../../src/server.js'

/**
 * Start the server on the given port and wait until the Synthea data has been
 * loaded (the first run of a ViewDefinition over Patient returns rows).
 *
 * @param {number} port - TCP port to listen on.
 * @param {object} [extra] - Additional config passed to `startServer`.
 * @returns {Promise<{server: object, base: string}>} the listening server and its base URL.
 */
export async function startTestServer(port, extra = {}) {
  const base = `http://localhost:${port}`
  const server = await startServer({ port, ...extra })
  await waitForData(base)
  return { server, base }
}

async function waitForData(base, maxAttempts = 90) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(
        `${base}/$sql-run?subjectReference=ViewDefinition/patient_demographics&_format=json`,
      )
      if (res.status === 200) {
        const rows = await res.json()
        if (Array.isArray(rows) && rows.length > 0) return
      }
    } catch {
      // Server not yet listening; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('FHIR data did not load within the allotted time')
}

/**
 * Build a Parameters resource from a list of parameter entries.
 *
 * @param {object[]} parameter - Parameters.parameter entries.
 * @returns {object} a Parameters resource.
 */
export function parameters(parameter) {
  return { resourceType: 'Parameters', parameter }
}

/**
 * POST a Parameters body to a path on the server.
 *
 * @param {string} base - Server base URL.
 * @param {string} path - Request path.
 * @param {object} body - JSON body.
 * @param {object} [headers] - Extra request headers.
 * @returns {Promise<Response>} the fetch response.
 */
export async function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json', ...headers },
    body: JSON.stringify(body),
  })
}

/**
 * Build an inline SQLQuery Library depending on a single ViewDefinition.
 *
 * @param {string} sql - The SQL text.
 * @param {object[]} dependsOn - `{resource, label}` entries for relatedArtifact.
 * @param {object[]} [parameter] - Library.parameter declarations.
 * @returns {object} the Library resource.
 */
export function sqlQueryLibrary(sql, dependsOn, parameter) {
  return {
    resourceType: 'Library',
    meta: { profile: ['http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/SQLQuery'] },
    status: 'active',
    type: {
      coding: [
        { system: 'http://hl7.org/fhir/uv/sql-on-fhir/CodeSystem/LibraryTypesCodes', code: 'sql-query' },
      ],
    },
    ...(parameter ? { parameter } : {}),
    relatedArtifact: dependsOn.map((d) => ({ type: 'depends-on', resource: d.resource, label: d.label })),
    content: [
      {
        contentType: 'application/sql',
        data: Buffer.from(sql).toString('base64'),
        extension: [
          { url: 'http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/sql-text', valueString: sql },
        ],
      },
    ],
  }
}

/**
 * Build an inline SQLView Library.
 *
 * @param {string} url - Canonical URL of the view.
 * @param {string} sql - The SQL text.
 * @param {object[]} dependsOn - `{resource, label}` entries for relatedArtifact.
 * @returns {object} the Library resource.
 */
export function sqlViewLibrary(url, sql, dependsOn) {
  const lib = sqlQueryLibrary(sql, dependsOn)
  lib.url = url
  lib.meta.profile = ['http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/SQLView']
  lib.type.coding[0].code = 'sql-view'
  return lib
}

/**
 * A minimal inline ViewDefinition over Patient.
 *
 * @param {string} [url] - Optional canonical URL.
 * @returns {object} the ViewDefinition.
 */
export function patientView(url) {
  return {
    resourceType: 'ViewDefinition',
    ...(url ? { url } : {}),
    status: 'active',
    resource: 'Patient',
    select: [
      {
        column: [
          { name: 'id', path: 'getResourceKey()', type: 'id' },
          { name: 'gender', path: 'gender', type: 'code' },
          { name: 'birth_date', path: 'birthDate', type: 'date' },
        ],
      },
    ],
  }
}

/**
 * Two Patient ids present in the Synthea fixture data set and in the
 * `synthea-two-patients` Group fixture.
 */
export const KNOWN_PATIENTS = ['5ab3b247-dc11-35cb-3ed6-8be889f6ccbe', '3cad20f0-3f8f-acdf-5523-91548be2870b']
