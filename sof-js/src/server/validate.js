import { errors as verrors } from '../validate.js'
import { layout, escapeHtml } from './ui.js'
import { read } from './db.js'
import { renderOperationDefinition } from './utils.js'
import { validateSqlLibrary } from './sqlLibraryValidation.js'

const defaultResource = {
  resourceType: 'ViewDefinition',
  name: 'patient_demographics',
  description: 'Patient demographics',
  resource: 'Patient',
  select: [
    {
      column: [
        { path: 'getResourceKey()', name: 'id', type: 'string' },
        { path: 'name.given.first()', name: 'given', type: 'string' },
        { path: 'name.family.first()', name: 'family', type: 'string' },
        { path: 'birthDate', name: 'birthDate', type: 'date' },
        { path: 'gender', name: 'gender', type: 'code' },
      ],
    },
  ],
}

export async function getValidateFormEndpoint(req, res) {
  const operation = await read(req.config, 'OperationDefinition', '$validate')
  const defaults = {
    resource: JSON.stringify(defaultResource, null, 2),
    format: 'csv',
  }
  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
      <div class="container mx-auto p-4">
        <div class="flex items-center gap-4">
          <a href="/">Home</a>
          <span class="text-gray-500">/</span>
          <a href="/ViewDefinition/">ViewDefinition</a>
          <span class="text-gray-500">/</span>
          <a href="/ViewDefinition/$validate">$validate</a>
        </div>
        <div class="">
            <div class="flex-1">
                <form 
                    hx-post="/ViewDefinition/$validate/form" 
                    hx-target="#result"
                    hx-swap="innerHTML"
                    hx-trigger="submit" >
                    <div class="mt-4">
                     ${await renderOperationDefinition(req, operation, defaults)}
                    </div>
                    <div class="mt-4">
                     <button type="submit" class="bg-blue-500 text-white px-4 py-1 rounded-md text-sm">Evaluate</button>
                    </div>
                </form>
            </div>
            <div class="flex-1" id="result"></div>
        </div>
      </div>
    `),
  )
}

function validateViewDefinition(resource) {
  return verrors(resource)
}

/**
 * Convert a list of AJV validation errors to FHIR OperationOutcome issues.
 *
 * Each AJV error is mapped to an issue with severity "error", code
 * "invariant", a human-readable diagnostics message, and an expression that
 * identifies the offending path when available.
 *
 * @param {Array|null} ajvErrors - Array of AJV error objects, or null when
 *   the schema compiled but produced no errors.
 * @returns {Array<{severity: string, code: string, diagnostics: string,
 *   expression?: string}>} FHIR OperationOutcome issue entries.
 */
function ajvErrorsToIssues(ajvErrors) {
  if (!ajvErrors || ajvErrors.length === 0) return []
  return ajvErrors.map((err) => {
    const issue = {
      severity: 'error',
      code: 'invariant',
      diagnostics: err.message ?? 'Validation error',
    }
    if (err.instancePath) {
      issue.expression = err.instancePath
    }
    return issue
  })
}

/**
 * Validate a ViewDefinition resource posted as JSON and return an
 * OperationOutcome.
 *
 * Replaces the previous implementation which called req.body.json()
 * (incorrect under Express, where req.body is already parsed) and echoed the
 * resource back without validating it.
 *
 * @param {object} req - Express request.  Body must be a ViewDefinition
 *   resource.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
export async function postValidateEndpoint(req, res) {
  const resource = req.body
  const ajvErrors = validateViewDefinition(resource)
  const issues = ajvErrorsToIssues(ajvErrors)
  const outcome = { resourceType: 'OperationOutcome', issue: issues }
  res.setHeader('Content-Type', 'application/fhir+json')
  res.status(200).json(outcome)
}

export async function postValidateFormEndpoint(req, res) {
  try {
    const resource = JSON.parse(req.body.resource)
    const result = validateViewDefinition(resource)
    res.setHeader('Content-Type', 'text/html')
    res.send(
      layout(`
            <div class="container mx-auto py-4">
                <pre class="bg-gray-100 p-4 rounded-md text-xs">${JSON.stringify(result, null, 2)}</pre>
            </div>
        `),
    )
  } catch (error) {
    res.setHeader('Content-Type', 'text/html')
    res.send(
      layout(`
            <div class="container mx-auto p-4 bg-red-100 border border-red-500 rounded-md">
                <h1 class="text-2xl">Error</h1>
                <p class="text-red-500">Invalid JSON: ${error.message}</p>  
            </div>
        `),
    )
  }
  res.end()
}

// ---------------------------------------------------------------------------
// Library $validate
// ---------------------------------------------------------------------------

// Escape user-supplied strings before inserting them into HTML output.

// A sample SQLQuery Library used to pre-fill the validation form.
const defaultLibraryResource = {
  resourceType: 'Library',
  status: 'active',
  type: {
    coding: [{ system: 'https://sql-on-fhir.org/ig/CodeSystem/LibraryTypesCodes', code: 'sql-query' }],
  },
  relatedArtifact: [
    {
      type: 'depends-on',
      resource: 'http://myig.org/ViewDefinition/patient_demographics',
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

/**
 * Render the issue list returned by validateSqlLibrary as an HTML fragment.
 *
 * @param {Array<{severity: string, code: string, diagnostics: string, expression?: string}>} issues - validation issues.
 * @returns {string} HTML string.
 */
function renderIssuesHtml(issues) {
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  if (issues.length === 0) {
    return `<p class="text-green-700 font-semibold">No errors - Library is conformant.</p>`
  }

  const renderList = (items, labelClass) =>
    items
      .map(
        (i) => `
        <li class="mt-1">
          <span class="${labelClass} font-semibold">${escapeHtml(i.severity)}</span>
          [<code>${escapeHtml(i.code)}</code>]:
          ${escapeHtml(i.diagnostics)}
          ${i.expression ? `<br/><span class="text-xs text-gray-500">${escapeHtml(i.expression)}</span>` : ''}
        </li>
      `,
      )
      .join('')

  return `
    <ul class="list-disc pl-4 text-sm">
      ${renderList(errors, 'text-red-700')}
      ${renderList(warnings, 'text-yellow-700')}
    </ul>
  `
}

/**
 * Serve the Library $validate HTML form.
 *
 * Reads the Library-scoped $validate OperationDefinition and renders its
 * title and description so the page reflects accurate Library-specific
 * metadata rather than re-using the ViewDefinition-scoped definition.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
export async function getLibraryValidateFormEndpoint(req, res) {
  const operation = await read(req.config, 'OperationDefinition', 'Library-$validate')
  const opTitle = operation?.title ?? operation?.name ?? 'Library $validate'
  const opDescription =
    operation?.description ??
    'Paste a Library resource below and click Evaluate to check it against the SQLQuery/SQLView profile rules.'
  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
      <div class="container mx-auto p-4">
        <div class="flex items-center gap-4">
          <a href="/">Home</a>
          <span class="text-gray-500">/</span>
          <a href="/Library">Library</a>
          <span class="text-gray-500">/</span>
          <span class="text-gray-700">$validate</span>
        </div>
        <h1 class="mt-4 text-2xl font-bold">${escapeHtml(opTitle)}</h1>
        <p class="mt-2 text-sm text-gray-600">${escapeHtml(opDescription)}</p>
        <div class="mt-4 flex gap-4">
          <div class="flex-1">
            <form
              hx-post="/Library/$validate/form"
              hx-target="#validate-result"
              hx-swap="innerHTML">
              <label class="block text-sm font-semibold mb-1" for="library-json">
                Resource (Library JSON)
              </label>
              <textarea
                id="library-json"
                name="resource"
                rows="20"
                class="w-full font-mono text-xs border border-gray-300 rounded p-2"
              >${escapeHtml(JSON.stringify(defaultLibraryResource, null, 2))}</textarea>
              <div class="mt-2">
                <button type="submit" class="btn">Evaluate</button>
              </div>
            </form>
          </div>
          <div class="flex-1">
            <p class="text-sm font-semibold mb-1">Result</p>
            <div id="validate-result" class="border border-gray-200 rounded p-3 min-h-12 text-sm"></div>
          </div>
        </div>
      </div>
    `),
  )
}

/**
 * Validate a Library resource posted as JSON and return an OperationOutcome.
 *
 * @param {object} req - Express request.  Body must be a Library resource.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
export async function postLibraryValidateEndpoint(req, res) {
  const library = req.body
  const issues = await validateSqlLibrary(library, req.config)
  const outcome = { resourceType: 'OperationOutcome', issue: issues }
  res.setHeader('Content-Type', 'application/fhir+json')
  res.status(200).json(outcome)
}

/**
 * Handle form submission for the Library $validate page.  Parses the posted
 * JSON, runs validation, and renders the issues as HTML.
 *
 * @param {object} req - Express request.  Body must have a `resource` field.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
export async function postLibraryValidateFormEndpoint(req, res) {
  res.setHeader('Content-Type', 'text/html')
  let library
  try {
    library = JSON.parse(req.body.resource)
  } catch (err) {
    const html = `
      <div class="bg-red-50 border border-red-300 rounded p-3">
        <p class="text-sm text-red-700 font-semibold">Invalid JSON</p>
        <p class="text-xs text-red-600 mt-1">${escapeHtml(err.message)}</p>
      </div>
    `
    res.send(req.headers['hx-request'] ? html : layout(`<div class="container mx-auto p-4">${html}</div>`))
    return
  }
  const issues = await validateSqlLibrary(library, req.config)
  const html = renderIssuesHtml(issues)
  res.send(req.headers['hx-request'] ? html : layout(`<div class="container mx-auto p-4">${html}</div>`))
}

export function mountRoutes(app) {
  // Library $validate routes must be mounted before the FHIR catch-all so that
  // /Library/$validate is not shadowed by the generic /:resourceType/:id route.
  app.get('/Library/\\$validate', getLibraryValidateFormEndpoint)
  app.post('/Library/\\$validate', postLibraryValidateEndpoint)
  app.post('/Library/\\$validate/form', postLibraryValidateFormEndpoint)

  app.get('/ViewDefinition/\\$validate', getValidateFormEndpoint)
  app.post('/ViewDefinition/\\$validate/form', postValidateFormEndpoint)
  app.post('/ViewDefinition/\\$validate', postValidateEndpoint)
}
