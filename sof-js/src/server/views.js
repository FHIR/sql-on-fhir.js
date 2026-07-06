import { wrapBundle, isHtml, sanitizeIdent } from './utils.js'
import { layout, escapeHtml } from './ui.js'
import { search, read } from './db.js'

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

function saveViewDefinition(config, resource) {
  return new Promise((resolve, reject) => {
    config.db.run(
      `CREATE TABLE IF NOT EXISTS viewdefinition ( id text PRIMARY KEY, resource JSON);`,
      (err) => {
        if (err) return reject(err)
        config.db.run(
          `INSERT OR REPLACE INTO viewdefinition (id, resource) VALUES (?, ?)`,
          [resource.id, JSON.stringify(resource)],
          (e) => (e ? reject(e) : resolve(resource)),
        )
      },
    )
  })
}

const VIEW_ICON = `<svg class="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm6.5.75v3h3v-3Zm3 4.5h-3v3h3Zm1.5 3h3v-3h-3Zm3-4.5v-3h-3v3Zm-9-3h-3v3h3Zm-3 4.5v3h3v-3Z"/>
</svg>`

function viewRow(resource) {
  return `
      <li class="group flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
        ${VIEW_ICON}
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

function viewGroup(resourceType, items) {
  return `
    <section class="mt-6">
      <div class="flex items-center gap-2 mb-2">
        <span class="px-2 py-0.5 rounded bg-slate-100 font-mono text-sm font-semibold">${escapeHtml(resourceType)}</span>
        <span class="text-gray-400 text-sm">${items.length} view${items.length === 1 ? '' : 's'}</span>
      </div>
      <ul class="border border-gray-200 rounded-md divide-y divide-gray-200 overflow-hidden">
        ${items.map(viewRow).join('')}
      </ul>
    </section>`
}

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
    : `<div class="mt-6 border border-dashed border-gray-300 rounded-md p-8 text-center text-gray-500">
             No view definitions yet. <a href="/ViewDefinition/new" class="text-blue-600 hover:underline">Create one</a>.
           </div>`
  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
        <div class="container mx-auto p-4 max-w-4xl">
            <div class="flex gap-2 items-center text-sm">
                <a href="/" class="text-blue-500 hover:text-blue-700">Home</a>
                <span class="text-gray-400">/</span>
                <span>View Definitions</span>
            </div>
            <div class="mt-4 flex flex-wrap items-center gap-2 border-b border-gray-200 pb-2">
                <h1 class="flex-1 text-2xl font-bold">View Definitions</h1>
                <a href="/ViewDefinition/$viewdefinition-export" class="btn">$viewdefinition-export</a>
                <a href="/ViewDefinition/$validate" class="btn">$validate?</a>
                <a href="/ViewDefinition/$evaluate" class="btn">$evaluate</a>
                <a href="/ViewDefinition/new" class="btn">New ViewDefinition</a>
            </div>
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

const NEW_INPUT = 'border border-gray-300 rounded p-2 w-full'

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
            <div class="flex gap-2 items-center text-sm">
                <a href="/" class="text-blue-500 hover:text-blue-700">Home</a>
                <span class="text-gray-400">/</span>
                <a href="/ViewDefinition" class="text-blue-500 hover:text-blue-700">View Definitions</a>
                <span class="text-gray-400">/</span>
                <span>New</span>
            </div>
            <h1 class="mt-4 text-2xl font-bold">New View Definition</h1>
            <form method="post" action="/ViewDefinition" class="mt-4 space-y-4">
                ${errorHtml}
                <div class="flex gap-3">
                    <div class="flex-1">
                        <label class="block font-semibold mb-1">Name</label>
                        <input name="name" value="${escapeHtml(name)}" class="${NEW_INPUT}" placeholder="my_view" />
                    </div>
                    <div class="flex-1">
                        <label class="block font-semibold mb-1">Resource</label>
                        <select name="resource" class="${NEW_INPUT}">${resourceOpts}</select>
                    </div>
                    <div class="w-40">
                        <label class="block font-semibold mb-1">Status</label>
                        <select name="status" class="${NEW_INPUT}">${statusOpts}</select>
                    </div>
                </div>
                <div>
                    <label class="block font-semibold mb-1">Definition
                        <span class="text-gray-400 font-normal text-sm">— full ViewDefinition JSON; Name / Resource / Status above override these fields</span>
                    </label>
                    <textarea name="definition" rows="16" class="${NEW_INPUT} font-mono text-xs">${escapeHtml(definition)}</textarea>
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
    await saveViewDefinition(req.config, resource)
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
