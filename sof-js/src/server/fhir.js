import fs from 'fs'
import { wrapBundle, isHtml } from './utils.js'
import { search, read, tableExists } from './db.js'
import { layout, escapeHtml, breadcrumb, pageHeader, listSection, emptyState, jsonBlock } from './ui.js'

export async function getCapabilityStatementEndpoint(req, res) {
  const capabilityStatement = JSON.parse(fs.readFileSync('./metadata/CapabilityStatement.json', 'utf8'))
  if (isHtml(req)) {
    res.send(
      layout(`
            <div class="container mx-auto p-4 max-w-4xl">
                ${breadcrumb('<span>metadata</span>')}
                ${pageHeader('Capability Statement')}
                ${jsonBlock(capabilityStatement)}
            </div>
        `),
    )
  } else {
    res.setHeader('Content-Type', 'application/fhir+json')
    res.json(capabilityStatement)
  }
}

function resourceRow(resource) {
  return `
      <li class="group flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
        <a href="/${resource.resourceType}/${resource.id}"
           class="font-mono text-sm text-blue-600 hover:underline truncate">${escapeHtml(resource.id)}</a>
      </li>`
}

function renderResourceTypeEndpoint(req, res, resourceType, resources) {
  const body = resources.length
    ? listSection(resourceType, resources, 'resource', resourceRow)
    : emptyState(`No ${escapeHtml(resourceType)} resources.`)
  res.send(
    layout(`
        <div class="container mx-auto p-4 max-w-4xl">
            ${breadcrumb(`<span>${escapeHtml(resourceType)}</span>`)}
            ${pageHeader(escapeHtml(resourceType))}
            ${body}
        </div>
    `),
  )
}

export async function getResourceTypeEndpoint(req, res) {
  const resourceType = req.params.resourceType
  if (!(await tableExists(req.config, resourceType))) {
    res.status(404)
    res.json({
      resourceType: 'OperationOutcome',
      issue: [{ code: 'not-found', message: 'Resource type not found' }],
    })
    return
  }
  const resources = await search(req.config, resourceType)
  if (isHtml(req)) {
    renderResourceTypeEndpoint(req, res, resourceType, resources)
  } else {
    res.setHeader('Content-Type', 'application/fhir+json')
    res.json(wrapBundle(resources))
  }
}

export async function getResourceEndpoint(req, res) {
  const resourceType = req.params.resourceType
  const id = req.params.id
  const resource = await read(req.config, resourceType, id)
  if (resource == null) {
    res.status(404)
    res.json({
      resourceType: 'OperationOutcome',
      issue: [{ code: 'not-found', message: 'Resource not found' }],
    })
    return
  }
  if (isHtml(req)) {
    res.setHeader('Content-Type', 'text/html')
    res.send(
      layout(`
            <div class="container mx-auto p-4 max-w-4xl">
                ${breadcrumb(
                  `<a href="/${resource.resourceType}" class="text-blue-500 hover:text-blue-700">${escapeHtml(resource.resourceType)}</a>`,
                  `<span class="font-mono">${escapeHtml(id)}</span>`,
                )}
                ${pageHeader(`${escapeHtml(resource.resourceType)} <span class="font-mono text-lg text-gray-500">${escapeHtml(id)}</span>`)}
                ${jsonBlock(resource)}
            </div>
        `),
    )
  } else {
    res.setHeader('Content-Type', 'application/fhir+json')
    res.json(resource)
  }
}

export function mountRoutes(app) {
  app.get('/metadata', getCapabilityStatementEndpoint)
  app.get('/:resourceType', getResourceTypeEndpoint)
  app.get('/:resourceType/:id', getResourceEndpoint)
}
