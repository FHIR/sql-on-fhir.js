/**
 * Server utilities: fixture loading, request helpers and rendering of an
 * OperationDefinition as an HTML table.
 *
 * Authors: niquola, jmandel, John Grimes
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { gunzip } from 'zlib'
import { search, expandValueSet } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DATABASE_URL = 'https://storage.googleapis.com/aidbox-public/synthea/v2/100/fhir/'

/** Clinical resource types loaded from the Synthea bundle. */
export const resourceTypes = [
  'AllergyIntolerance',
  'CarePlan',
  'CareTeam',
  'Claim',
  'Condition',
  'Device',
  'DiagnosticReport',
  'DocumentReference',
  'Encounter',
  'ExplanationOfBenefit',
  'ImagingStudy',
  'Immunization',
  'Location',
  'Medication',
  'MedicationAdministration',
  'MedicationRequest',
  'Observation',
  'Organization',
  'Patient',
  'Practitioner',
  'PractitionerRole',
  'Procedure',
  'Provenance',
  'SupplyDelivery',
]

export async function getFHIRData(resourceType) {
  if (!resourceTypes.includes(resourceType)) {
    return null
  }
  const response = await fetch(DATABASE_URL + resourceType + '.ndjson.gz')
  const buffer = new Uint8Array(await response.arrayBuffer())
  const text = await new Promise((resolve, reject) => {
    gunzip(buffer, (err, result) => (err ? reject(err) : resolve(result.toString('utf8'))))
  })
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/**
 * Read every JSON resource under `metadata/<resourceType>/`, taking each
 * resource's id from its file name.
 *
 * @param {string} resourceType - Directory name under `metadata/`.
 * @returns {object[]|null} the resources, or null when the directory is absent.
 */
export function readResourcesFromDirectory(resourceType) {
  const directoryPath = path.join(__dirname, '../../metadata', resourceType)
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    return null
  }
  const resources = []
  for (const file of fs.readdirSync(directoryPath)) {
    const filePath = path.join(directoryPath, file)
    if (!fs.statSync(filePath).isFile() || !file.endsWith('.json')) continue
    try {
      const resource = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      resource.id = file.replace(/\.json$/, '')
      resources.push(resource)
    } catch (error) {
      console.error(`Error processing file ${file}:`, error)
    }
  }
  return resources
}

/**
 * Absolute path of the `metadata/` directory.
 *
 * @returns {string} the path.
 */
export function metadataDir() {
  return path.join(__dirname, '../../metadata')
}

export function wrapBundle(resources) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: resources.length,
    entry: resources.map((resource) => ({ resource })),
  }
}

export function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`
}

/**
 * Whether the client is a browser expecting HTML rather than FHIR JSON.
 *
 * @param {object} req - Express request.
 * @returns {boolean} true for an `Accept` header naming `text/html`.
 */
export function isHtml(req) {
  return req.query._format !== 'json' && (req.headers.accept || '').includes('text/html')
}

export function arrayify(value) {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function bindingHtml(req, param) {
  if (!param.binding) return ''
  const valueSet = await expandValueSet(req.config, param.binding.valueSet)
  return valueSet
    ? `<a href="/ValueSet/${valueSet.id}">${escapeHtml(valueSet.id)}</a>`
    : `<span class="text-red-500">${escapeHtml(param.binding.valueSet)}</span>`
}

async function inputHtml(req, param, defaults) {
  if (param.use !== 'in') return ''
  const defaultValue = defaults[param.name]
  switch (param.type) {
    case 'code': {
      const valueSet = param.binding ? await expandValueSet(req.config, param.binding.valueSet) : null
      if (valueSet?.concept) {
        return `<select name="${param.name}">${valueSet.concept.map((c) => `<option value="${c.code}">${escapeHtml(c.display)}</option>`).join('')}</select>`
      }
      return `<input name="${param.name}" type="text"/>`
    }
    case 'Reference': {
      if (param.name !== 'patient') return `<input name="${param.name}" type="text"/>`
      const patients = await search(req.config, 'Patient', 100)
      return `<select name="${param.name}">${patients.map((p) => `<option value="${p.id}">${escapeHtml(p.name?.[0]?.family)} ${escapeHtml(p.name?.[0]?.given?.[0])}</option>`).join('')}</select>`
    }
    case 'ViewDefinition':
    case 'CanonicalResource':
    case 'Resource':
    case 'Parameters':
      return `<textarea name="${param.name}" rows="10" cols="90">${escapeHtml(defaultValue || '{"resourceType": "ViewDefinition", "resource": "Patient"}')}</textarea>`
    case 'number':
    case 'integer':
      return `<input name="${param.name}" type="number"/>`
    case 'boolean':
      return `<input name="${param.name}" type="checkbox" value="true"/>`
    case 'date':
      return `<input name="${param.name}" type="date"/>`
    case 'dateTime':
    case 'instant':
      return `<input name="${param.name}" type="datetime-local"/>`
    case 'time':
      return `<input name="${param.name}" type="time"/>`
    default:
      return `<input name="${param.name}" type="text"/>`
  }
}

async function renderOpInputDefParam(req, param, defaults, ident = '') {
  let input = await inputHtml(req, param, defaults)
  if (param.max !== '1' && param.use === 'in') {
    input = `<div class="multiply-row remove-row flex space-x-2 py-1">${input} <a class="btn" hx-ext="multiply">+</a> <a class="btn" hx-ext="remove">-</a></div>`
  }
  const nested = await Promise.all(
    (param.part || []).map((p) => renderOpInputDefParam(req, p, defaults, ident + param.name + '.')),
  )
  return `
    <tr>
        <td>${ident}${param.name}</td>
        <td class="min-w-80">${input}</td>
        <td>${param.type || ''}</td>
        <td>${param.min || 0}..${param.max || '*'}</td>
        <td class="text-xs text-gray-500">${await bindingHtml(req, param)} ${escapeHtml(param.documentation || '')}</td>
    </tr>
    ${nested.join('')}`
}

async function renderOpOutputDefParam(req, param, ident = '') {
  const nested = await Promise.all(
    (param.part || []).map((p) => renderOpOutputDefParam(req, p, ident + param.name + '.')),
  )
  return `
    <tr>
        <td>${ident}${param.name}</td>
        <td>${param.type || ''}</td>
        <td>${param.min || 0}..${param.max || '*'}</td>
        <td class="text-xs text-gray-500">${await bindingHtml(req, param)} ${escapeHtml(param.documentation || '')}</td>
    </tr>
    ${nested.join('')}`
}

/**
 * Render an OperationDefinition as documentation tables with an input control
 * per input parameter.
 *
 * @param {object} req - Express request (used to expand bindings and list patients).
 * @param {object} operation - The OperationDefinition.
 * @param {object} [defaults] - Default values keyed by parameter name.
 * @returns {Promise<string>} the HTML.
 */
export async function renderOperationDefinition(req, operation, defaults = {}) {
  const inputParams = operation.parameter.filter((p) => p.use === 'in')
  const outputParams = operation.parameter.filter((p) => p.use === 'out')
  const inputParamHtml = await Promise.all(
    inputParams.map((param) => renderOpInputDefParam(req, param, defaults)),
  )
  const outputParamHtml = await Promise.all(outputParams.map((param) => renderOpOutputDefParam(req, param)))
  return `
    <div class="mt-4">
        <h2 class="text-2xl font-bold mt-4"> ${escapeHtml(operation.name)} </h2>
        <p class="mt-4"> ${escapeHtml(operation.description)} </p>
        <details class="mt-4">
            <summary class="text-sky-600 hover:text-sky-700 cursor-pointer">OperationDefinition</summary>
            <pre>${escapeHtml(JSON.stringify(operation, null, 2))}</pre>
        </details>
        <h3 class="text-lg font-bold mt-4 mb-2"> Output </h3>
        <table class="mt-4">
            <thead><tr><th>Name</th><th>Type</th><th>Min..Max</th><th>Documentation</th></tr></thead>
            <tbody>${outputParamHtml.join('')}</tbody>
        </table>
        <h3 class="text-lg font-bold mt-4 mb-2"> Input </h3>
        <table class="mt-4">
            <thead><tr><th>Name</th><th>Input</th><th>Type</th><th>Min..Max</th><th>Documentation</th></tr></thead>
            <tbody>${inputParamHtml.join('')}</tbody>
        </table>
    </div>`
}
