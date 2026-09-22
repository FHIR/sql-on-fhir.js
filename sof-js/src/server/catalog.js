// Catalog pages that group the definition resources by role rather than by FHIR
// type: Views (ViewDefinition + SQLView — composable, materializable recipes)
// and Queries (SQL Query — terminal queries run with parameters).

import { search } from './db.js'
import { isHtml, wrapBundle } from './utils.js'
import { layout, breadcrumb, pageHeader, listSection, emptyState, tableIcon, escapeHtml } from './ui.js'

const hasType = (lib, code) => (lib.type?.coding || []).some((c) => c.code === code)

function catalogRow(item) {
  const actions = item.actions
    .map(
      (a) =>
        `<a class="text-blue-600 hover:underline opacity-60 group-hover:opacity-100" href="${a.href}">${escapeHtml(a.label)}</a>`,
    )
    .join('')
  return `
      <li class="group flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
        ${tableIcon()}
        <div class="flex-1 min-w-0">
          <a href="${item.detailHref}" class="font-semibold text-blue-600 hover:underline truncate">${escapeHtml(item.name)}</a>
          <div class="mt-0.5 text-xs text-gray-500 truncate font-mono" title="${escapeHtml(item.url || '')}">${escapeHtml(item.url || '')}</div>
        </div>
        <div class="shrink-0 flex items-center gap-3 text-sm">${actions}</div>
      </li>`
}

const materializeAction = (ref) => ({
  label: 'materialize',
  href: `/MaterializedView/new?view=${encodeURIComponent(ref)}`,
})

export async function getViewsEndpoint(req, res) {
  const vds = await search(req.config, 'ViewDefinition', 1000)
  const sqlViews = (await search(req.config, 'Library', 1000)).filter((l) => hasType(l, 'sql-view'))

  if (!isHtml(req)) {
    res.setHeader('Content-Type', 'application/fhir+json')
    return res.json(wrapBundle([...vds, ...sqlViews]))
  }

  const vdItems = vds.map((v) => {
    const ref = v.url || `ViewDefinition/${v.id}`
    return {
      name: v.name || v.id,
      detailHref: `/ViewDefinition/${v.id}`,
      url: v.url || '',
      actions: [{ label: '$run', href: `/ViewDefinition/${v.id}/$run/form` }, materializeAction(ref)],
    }
  })
  const svItems = sqlViews.map((l) => {
    const ref = l.url || `Library/${l.id}`
    return {
      name: l.name || l.id,
      detailHref: `/Library/${l.id}`,
      url: l.url || '',
      actions: [
        { label: '$sqlquery-run', href: `/Library/${l.id}/$sqlquery-run/form` },
        materializeAction(ref),
      ],
    }
  })

  const sections = []
  if (vdItems.length) sections.push(listSection('ViewDefinition', vdItems, 'view', catalogRow))
  if (svItems.length) sections.push(listSection('SQLView', svItems, 'view', catalogRow))
  const body = sections.length ? sections.join('') : emptyState('No views yet.')

  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
      <div class="container mx-auto p-4 max-w-4xl">
        ${breadcrumb('<span>Views</span>')}
        ${pageHeader(
          'Views',
          `<a href="/ViewDefinition/new" class="btn">New ViewDefinition</a>
           <a href="/Library/new" class="btn">New SQLView</a>`,
        )}
        ${body}
      </div>`),
  )
}

export async function getQueriesEndpoint(req, res) {
  const queries = (await search(req.config, 'Library', 1000)).filter((l) => hasType(l, 'sql-query'))

  if (!isHtml(req)) {
    res.setHeader('Content-Type', 'application/fhir+json')
    return res.json(wrapBundle(queries))
  }

  const items = queries.map((l) => ({
    name: l.name || l.id,
    detailHref: `/Library/${l.id}`,
    url: l.url || '',
    actions: [{ label: '$sqlquery-run', href: `/Library/${l.id}/$sqlquery-run/form` }],
  }))
  const body = items.length
    ? listSection('SQL Query', items, 'query', catalogRow)
    : emptyState('No queries yet.')

  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
      <div class="container mx-auto p-4 max-w-4xl">
        ${breadcrumb('<span>Queries</span>')}
        ${pageHeader('Queries', '<a href="/Library/new" class="btn">New SQL Query</a>')}
        ${body}
      </div>`),
  )
}

export function mountRoutes(app) {
  app.get('/Views', getViewsEndpoint)
  app.get('/Queries', getQueriesEndpoint)
}
