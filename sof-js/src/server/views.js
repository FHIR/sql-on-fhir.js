import { wrapBundle, isHtml, sanitizeIdent } from './utils.js'
import {
  layout,
  escapeHtml,
  breadcrumb,
  tableIcon,
  listSection,
  pageHeader,
  emptyState,
  FORM_INPUT,
} from './ui.js'
import { search, read, saveResource } from './db.js'

const FHIR_RESOURCE_TYPES = [
  'Patient',
  'Observation',
  'Condition',
  'Encounter',
  'Procedure',
  'MedicationRequest',
  'AllergyIntolerance',
  'Immunization',
  'DiagnosticReport',
  'Practitioner',
  'Organization',
  'DocumentReference',
]

// A ViewDefinition id: the shared identifier rules, lowercased, with an empty
// input defaulting to 'view'.
function sanitizeId(s) {
  const trimmed = String(s || '').trim()
  if (!trimmed) return 'view'
  return sanitizeIdent(trimmed).toLowerCase()
}

function viewRow(resource) {
  return `
      <li class="group flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
        ${tableIcon()}
        <div class="flex-1 min-w-0">
          <a href="/ViewDefinition/${resource.id}"
             class="font-semibold text-blue-600 hover:underline truncate">${escapeHtml(resource.name || resource.id)}</a>
          <div class="mt-0.5 text-xs text-gray-500 truncate font-mono" title="${escapeHtml(resource.url || '')}">${escapeHtml(resource.url || '')}</div>
        </div>
        <div class="shrink-0 flex items-center gap-3 text-sm">
          <a class="text-blue-600 hover:underline opacity-60 group-hover:opacity-100" href="/ViewDefinition/${resource.id}/$run/form">$run</a>
        </div>
      </li>`
}

const viewGroup = (resourceType, items) => listSection(resourceType, items, 'view', viewRow)

function renderViewDefinitions(req, res, resources) {
  const groups = new Map()
  for (const v of resources) {
    const key = v.resource || '(unspecified)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(v)
  }
  const body = resources.length
    ? [...groups.keys()]
        .sort()
        .map((rt) => viewGroup(rt, groups.get(rt)))
        .join('')
    : emptyState(
        'No view definitions yet. <a href="/ViewDefinition/new" class="text-blue-600 hover:underline">Create one</a>.',
      )
  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
        <div class="container mx-auto p-4 max-w-4xl">
            ${breadcrumb('<span>View Definitions</span>')}
            ${pageHeader(
              'View Definitions',
              `<a href="/ViewDefinition/$viewdefinition-export" class="btn">$viewdefinition-export</a>
               <a href="/ViewDefinition/$validate" class="btn">$validate?</a>
               <a href="/ViewDefinition/$evaluate" class="btn">$evaluate</a>
               <a href="/ViewDefinition/new" class="btn">New ViewDefinition</a>`,
            )}
            ${body}
        </div>
    `),
  )
}

export async function getVeiwListEndpoint(req, res) {
  const resources = await search(req.config, 'ViewDefinition')
  if (isHtml(req)) {
    renderViewDefinitions(req, res, resources)
  } else {
    if (resources == null) {
      res.status(404)
      res.json({
        resourceType: 'OperationOutcome',
        issue: [
          {
            code: 'not-found',
            message: 'Resource type not found',
          },
        ],
      })
    } else {
      res.setHeader('Content-Type', 'application/fhir+json')
      res.json(wrapBundle(resources))
    }
  }
}

function renderViewDefinition(req, res, resource) {
  const resourceJson = JSON.stringify(resource, null, 2)
  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
        <div class="container mx-auto p-4">
            <div class="flex items-center space-x-4">
                <a href="/" class="text-blue-500 hover:text-blue-700">Home</a>
                <span class="text-gray-500">/</span>
                <a href="/ViewDefinition" class="text-blue-500 hover:text-blue-700">View Definitions</a>
                <span class="text-gray-500">/</span>
                <a href="#" class="text-blue-500 hover:text-blue-700">${resource.name}</a>
            </div>
            <div class="mt-4 flex items-center space-x-4 border-b border-gray-200 pb-2">  
                <h1 class="flex-1 text-2xl font-bold">View Definition</h1>
                <a href="/ViewDefinition/${resource.id}/$run/form" class="border border-blue-500 rounded-md px-2 py-1 text-sm text-blue-500 hover:text-blue-700">$run</a>
            </div>
            <pre class="bg-gray-100 p-4 rounded-md text-xs">${resourceJson}</pre>

        </div>
    `),
  )
}

export async function getVeiwEndpoint(req, res) {
  console.log('getVeiwEndpoint', req.params.id)
  const resource = await read(req.config, 'ViewDefinition', req.params.id)
  if (isHtml(req)) {
    if (resource == null) {
      res.send(
        layout(`
                <div class="container mx-auto p-4">
                    <h1 class="text-2xl font-bold mb-4">View Definition</h1>
                    <p>View Definition not found</p>
                </div>
            `),
      )
    } else {
      renderViewDefinition(req, res, resource)
    }
  } else {
    res.setHeader('Content-Type', 'application/fhir+json')
    res.json(resource)
  }
}

function viewNewTemplate(name, resource) {
  return JSON.stringify(
    {
      resourceType: 'ViewDefinition',
      name,
      resource,
      status: 'draft',
      select: [{ column: [{ name: 'id', path: 'getResourceKey()' }] }],
    },
    null,
    2,
  )
}

function renderNewForm(req, res, values = {}) {
  const name = values.name || 'my_view'
  const resourceType = values.resource || 'Patient'
  const resourceOpts = FHIR_RESOURCE_TYPES.map(
    (t) => `<option value="${t}"${t === resourceType ? ' selected' : ''}>${t}</option>`,
  ).join('')
  const statusOpts = ['draft', 'active', 'retired']
    .map((s) => `<option value="${s}"${s === (values.status || 'draft') ? ' selected' : ''}>${s}</option>`)
    .join('')
  const definition = values.definition || viewNewTemplate(name, resourceType)
  const errorHtml = values.error
    ? `<div class="p-3 border border-red-300 bg-red-50 rounded text-red-700 text-sm">${escapeHtml(values.error)}</div>`
    : ''
  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
        <div class="container mx-auto p-4 max-w-2xl">
            ${breadcrumb(
              '<a href="/ViewDefinition" class="text-blue-500 hover:text-blue-700">View Definitions</a>',
              '<span>New</span>',
            )}
            <h1 class="mt-4 text-2xl font-bold">New View Definition</h1>
            <form method="post" action="/ViewDefinition" class="mt-4 space-y-4">
                ${errorHtml}
                <div class="flex gap-3">
                    <div class="flex-1">
                        <label class="block font-semibold mb-1">Name</label>
                        <input name="name" value="${escapeHtml(name)}" class="${FORM_INPUT}" placeholder="my_view" />
                    </div>
                    <div class="flex-1">
                        <label class="block font-semibold mb-1">Resource</label>
                        <select name="resource" class="${FORM_INPUT}">${resourceOpts}</select>
                    </div>
                    <div class="w-40">
                        <label class="block font-semibold mb-1">Status</label>
                        <select name="status" class="${FORM_INPUT}">${statusOpts}</select>
                    </div>
                </div>
                <div>
                    <label class="block font-semibold mb-1">Definition
                        <span class="text-gray-400 font-normal text-sm">— full ViewDefinition JSON; Name / Resource / Status above override these fields</span>
                    </label>
                    <textarea name="definition" rows="16" class="${FORM_INPUT} font-mono text-xs">${escapeHtml(definition)}</textarea>
                </div>
                <button type="submit" class="btn">Create</button>
            </form>
        </div>
    `),
  )
}

export function getViewNewEndpoint(req, res) {
  renderNewForm(req, res)
}

export async function postViewEndpoint(req, res) {
  const body = req.body || {}
  let resource
  try {
    // The JSON textarea is the base; nested JSON API posts the resource directly.
    if (typeof body.definition === 'string' && body.definition.trim()) {
      resource = JSON.parse(body.definition)
    } else if (body.resourceType === 'ViewDefinition') {
      resource = body
    } else {
      resource = {}
    }
  } catch (e) {
    const msg = `Invalid JSON: ${e.message}`
    if (isHtml(req)) return renderNewForm(req, res, { ...body, error: msg })
    return res.status(400).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', diagnostics: msg }],
    })
  }

  resource.resourceType = 'ViewDefinition'
  // Convenience fields override the parsed JSON when provided.
  if (body.name) resource.name = body.name
  if (body.resource) resource.resource = body.resource
  if (body.status) resource.status = body.status

  if (!resource.name) {
    const msg = 'ViewDefinition.name is required'
    if (isHtml(req)) return renderNewForm(req, res, { ...body, error: msg })
    return res.status(400).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'required', diagnostics: msg }],
    })
  }

  resource.id = resource.id || sanitizeId(resource.name)
  resource.url = resource.url || `http://myig.org/ViewDefinition/${resource.id}`

  // Create semantics: refuse to silently overwrite an existing view. Two names
  // can sanitize to the same id (e.g. "My View" and "my-view" -> "my_view"),
  // and saveViewDefinition uses INSERT OR REPLACE, so guard here.
  const existing = await read(req.config, 'ViewDefinition', resource.id)
  if (existing) {
    const msg = `A ViewDefinition with id '${resource.id}' already exists; choose a different name.`
    if (isHtml(req)) return renderNewForm(req, res, { ...body, error: msg })
    return res.status(409).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'duplicate', diagnostics: msg }],
    })
  }

  try {
    await saveResource(req.config, 'ViewDefinition', resource)
  } catch (e) {
    if (isHtml(req)) return renderNewForm(req, res, { ...body, error: e.message })
    return res.status(500).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'exception', diagnostics: e.message }],
    })
  }

  if (isHtml(req)) return res.redirect(303, `/ViewDefinition/${resource.id}`)
  res.setHeader('Location', `/ViewDefinition/${resource.id}`)
  res.status(201).json(resource)
}

export function mountRoutes(app) {
  console.log('mounting views routes')
  app.get('/ViewDefinition', getVeiwListEndpoint)
  app.post('/ViewDefinition', postViewEndpoint)
  app.get('/ViewDefinition/new', getViewNewEndpoint)
  app.get('/ViewDefinition/:id', getVeiwEndpoint)
}
