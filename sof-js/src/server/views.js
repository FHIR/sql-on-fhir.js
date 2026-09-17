/**
 * Browsing pages for the stored ViewDefinitions and Libraries. Each row links
 * to the `$sql-run` form with that artifact preselected as the subject.
 *
 * Authors: niquola, jmandel, John Grimes
 */

import { wrapBundle, isHtml } from './utils.js'
import { layout } from './ui.js'
import { search, read } from './db.js'
import { artifactKind } from './operations.js'

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function breadcrumbs(...crumbs) {
  const items = [['/', 'Home'], ...crumbs]
  return `<div class="flex items-center space-x-4">${items
    .map(
      ([href, text]) => `<a href="${href}" class="text-blue-500 hover:text-blue-700">${escapeHtml(text)}</a>`,
    )
    .join('<span class="text-gray-500">/</span>')}</div>`
}

function runLink(resourceType, id) {
  return `<a class="text-blue-500 hover:text-blue-700" href="/$sql-run/form?subject=${resourceType}/${encodeURIComponent(id)}">$sql-run</a>`
}

const th = (text) => `<th class="bg-gray-100 border border-gray-200 p-2">${text}</th>`
const td = (html) => `<td class="border border-gray-200 p-2">${html}</td>`

function renderList(res, { title, resourceType, headers, rows }) {
  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
      <div class="container mx-auto p-4">
        ${breadcrumbs([`/${resourceType}`, title])}
        <div class="mt-4 flex items-center space-x-4 border-b border-gray-200 pb-2">
          <h1 class="flex-1 text-2xl font-bold">${title}</h1>
          <a href="/$sql-run/form" class="btn">$sql-run</a>
          <a href="/$sql-export/form" class="btn">$sql-export</a>
          <a href="/${resourceType}/$validate${resourceType === 'Library' ? '/form' : ''}" class="btn">$validate</a>
        </div>
        <table class="mt-4 table-auto border-collapse border border-gray-200">
          <thead><tr>${headers.map(th).join('')}</tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
    `),
  )
}

function sendBundle(res, resources) {
  res.setHeader('Content-Type', 'application/fhir+json')
  res.json(wrapBundle(resources))
}

export async function getViewListEndpoint(req, res) {
  const resources = await search(req.config, 'ViewDefinition', 1000)
  if (!isHtml(req)) return sendBundle(res, resources)
  renderList(res, {
    title: 'View Definitions',
    resourceType: 'ViewDefinition',
    headers: ['Name', 'Resource', 'URL', 'Run'],
    rows: resources.map(
      (r) =>
        `<tr>${td(`<a class="text-blue-500 hover:text-blue-700" href="/ViewDefinition/${encodeURIComponent(r.id)}">${escapeHtml(r.name || r.id)}</a>`)}${td(escapeHtml(r.resource))}${td(escapeHtml(r.url))}${td(runLink('ViewDefinition', r.id))}</tr>`,
    ),
  })
}

export async function getLibraryListEndpoint(req, res) {
  const resources = await search(req.config, 'Library', 1000)
  if (!isHtml(req)) return sendBundle(res, resources)
  renderList(res, {
    title: 'Libraries',
    resourceType: 'Library',
    headers: ['Name', 'Type', 'URL', 'Run'],
    rows: resources.map(
      (r) =>
        `<tr>${td(`<a class="text-blue-500 hover:text-blue-700" href="/Library/${encodeURIComponent(r.id)}">${escapeHtml(r.title || r.name || r.id)}</a>`)}${td(escapeHtml(artifactKind(r) || 'Library'))}${td(escapeHtml(r.url))}${td(runLink('Library', r.id))}</tr>`,
    ),
  })
}

async function getArtifactEndpoint(req, res, resourceType, listTitle) {
  const resource = await read(req.config, resourceType, req.params.id)
  if (!isHtml(req)) {
    if (!resource) {
      res.status(404)
      res.setHeader('Content-Type', 'application/fhir+json')
      return res.json({
        resourceType: 'OperationOutcome',
        issue: [
          { severity: 'error', code: 'not-found', diagnostics: `${resourceType}/${req.params.id} not found` },
        ],
      })
    }
    res.setHeader('Content-Type', 'application/fhir+json')
    return res.json(resource)
  }
  res.setHeader('Content-Type', 'text/html')
  if (!resource) {
    res.status(404)
    return res.send(
      layout(
        `<div class="container mx-auto p-4">${breadcrumbs([`/${resourceType}`, listTitle])}<p class="mt-4">${resourceType} not found</p></div>`,
      ),
    )
  }
  res.send(
    layout(`
      <div class="container mx-auto p-4">
        ${breadcrumbs([`/${resourceType}`, listTitle], [`/${resourceType}/${encodeURIComponent(resource.id)}`, resource.name || resource.id])}
        <div class="mt-4 flex items-center space-x-4 border-b border-gray-200 pb-2">
          <h1 class="flex-1 text-2xl font-bold">${escapeHtml(resource.title || resource.name || resource.id)}</h1>
          ${runLink(resourceType, resource.id)}
        </div>
        <pre class="bg-gray-100 p-4 rounded-md text-xs">${escapeHtml(JSON.stringify(resource, null, 2))}</pre>
      </div>
    `),
  )
}

export function mountRoutes(app) {
  app.get('/ViewDefinition', getViewListEndpoint)
  app.get('/ViewDefinition/:id', (req, res) =>
    getArtifactEndpoint(req, res, 'ViewDefinition', 'View Definitions'),
  )
  app.get('/Library', getLibraryListEndpoint)
  app.get('/Library/:id', (req, res) => getArtifactEndpoint(req, res, 'Library', 'Libraries'))
}
