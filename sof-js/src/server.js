import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { mountRoutes as mountExportRoutes } from './server/export.js'
import { mountRoutes as mountRunRoutes } from './server/run.js'
import { mountRoutes as mountFhirRoutes } from './server/fhir.js'
import { mountRoutes as mountViewsRoutes } from './server/views.js'
import { mountRoutes as mountEvaluateRoutes } from './server/evaluate.js'
import { mountRoutes as mountValidateRoutes } from './server/validate.js'
import { mountRoutes as mountSqlQueryRunRoutes } from './server/sql.js'
import { mountRoutes as mountMaterializedViewRoutes } from './server/materializedView.js'
import { migrate, getDb, select, tableExists } from './server/db.js'
import { resourceTypes } from './server/utils.js'
import { layout } from './server/ui.js'

async function countRows(config, table) {
  try {
    if (!(await tableExists(config, table))) return 0
    const rows = await select(config, `SELECT COUNT(*) AS n FROM ${table.toLowerCase()}`)
    return rows?.[0]?.n ?? 0
  } catch {
    return 0
  }
}

const ICONS = {
  view: `<svg class="w-6 h-6" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm6.5.75v3h3v-3Zm3 4.5h-3v3h3Zm1.5 3h3v-3h-3Zm3-4.5v-3h-3v3Zm-9-3h-3v3h3Zm-3 4.5v3h3v-3Z"/></svg>`,
  sql: `<svg class="w-6 h-6" viewBox="0 0 16 16" fill="currentColor"><path d="M4.72 3.22a.75.75 0 0 1 1.06 1.06L2.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L.47 8.53a.75.75 0 0 1 0-1.06Zm6.56 0a.75.75 0 1 0-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06l4.25-4.25a.75.75 0 0 0 0-1.06Z"/></svg>`,
  matview: `<svg class="w-6 h-6" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c3.31 0 6 1.12 6 2.5v11C14 14.88 11.31 16 8 16s-6-1.12-6-2.5v-11C2 1.12 4.69 0 8 0Zm4.5 5.55C11.4 6.13 9.8 6.5 8 6.5s-3.4-.37-4.5-.95V8.5c0 .3 1.5 1 4.5 1s4.5-.7 4.5-1Zm0 4C11.4 10.13 9.8 10.5 8 10.5s-3.4-.37-4.5-.95v3.95c0 .3 1.5 1 4.5 1s4.5-.7 4.5-1ZM8 5c3 0 4.5-.7 4.5-1S11 3 8 3s-4.5.7-4.5 1S5 5 8 5Z"/></svg>`,
}

function navCard({ href, icon, color, title, desc, count, actions }) {
  return `
    <a href="${href}" class="group block border border-gray-200 rounded-xl p-5 hover:border-blue-400 hover:shadow-sm transition">
      <div class="flex items-start gap-4">
        <div class="shrink-0 w-11 h-11 rounded-lg flex items-center justify-center ${color}">${icon}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="font-semibold text-gray-900 group-hover:text-blue-600">${title}</h3>
            ${count != null ? `<span class="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs tabular-nums">${count}</span>` : ''}
          </div>
          <p class="mt-1 text-sm text-gray-500">${desc}</p>
          ${actions ? `<div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">${actions}</div>` : ''}
        </div>
      </div>
    </a>`
}

function opLink(href, label) {
  return `<a href="${href}" class="inline-flex items-center px-3 py-1.5 rounded-md border border-gray-200 text-sm text-gray-700 hover:border-blue-400 hover:text-blue-600 font-mono">${label}</a>`
}

export async function getIndex(req, res) {
  const config = req.config
  const [views, queries, matviews] = await Promise.all([
    countRows(config, 'ViewDefinition'),
    countRows(config, 'Library'),
    countRows(config, 'MaterializedView'),
  ])

  const stop = (e) => `onclick="event.preventDefault();event.stopPropagation();window.location='${e}'"`

  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
    <div class="container mx-auto p-4 max-w-5xl">
      <header class="mt-6 mb-8">
        <h1 class="text-3xl font-bold tracking-tight">SQL on FHIR</h1>
        <p class="mt-2 text-gray-500 max-w-2xl">Reference server for portable, tabular projections of FHIR data — define views, run SQL queries and materialize relations across destinations.</p>
      </header>

      <div class="grid gap-4 md:grid-cols-3">
        ${navCard({
          href: '/ViewDefinition',
          icon: ICONS.view,
          color: 'bg-blue-50 text-blue-600',
          title: 'View Definitions',
          desc: 'Tabular projections of FHIR resources.',
          count: views,
          actions: `<span class="text-blue-600 hover:underline" ${stop('/ViewDefinition')}>Browse</span>
                    <span class="text-blue-600 hover:underline" ${stop('/ViewDefinition/new')}>New</span>`,
        })}
        ${navCard({
          href: '/Library',
          icon: ICONS.sql,
          color: 'bg-violet-50 text-violet-600',
          title: 'SQL Queries',
          desc: 'Composable SQL over views and resources.',
          count: queries,
          actions: `<span class="text-blue-600 hover:underline" ${stop('/Library')}>Browse</span>
                    <span class="text-blue-600 hover:underline" ${stop('/Library/$sqlquery-run/form')}>Run</span>`,
        })}
        ${navCard({
          href: '/MaterializedView',
          icon: ICONS.matview,
          color: 'bg-emerald-50 text-emerald-600',
          title: 'Materialized Views',
          desc: 'Persisted relations on sqlite / csv destinations.',
          count: matviews,
          actions: `<span class="text-blue-600 hover:underline" ${stop('/MaterializedView')}>Browse</span>
                    <span class="text-blue-600 hover:underline" ${stop('/MaterializedView/new')}>New</span>`,
        })}
      </div>

      <section class="mt-10">
        <h2 class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Operations</h2>
        <div class="flex flex-wrap gap-2">
          ${opLink('/metadata', 'metadata')}
          ${opLink('/$sqlquery-run/form', '$sqlquery-run')}
          ${opLink('/$viewdefinition-export', '$viewdefinition-export')}
          ${opLink('/ViewDefinition/$evaluate', '$evaluate')}
          ${opLink('/ViewDefinition/$validate', '$validate')}
        </div>
      </section>

      <section class="mt-10">
        <h2 class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">FHIR data</h2>
        <div class="flex flex-wrap gap-2">
          ${resourceTypes
            .slice()
            .sort()
            .map(
              (rt) =>
                `<a href="/${rt}" class="inline-flex items-center px-3 py-1 rounded-full bg-gray-50 border border-gray-200 text-sm text-gray-700 hover:border-blue-400 hover:text-blue-600">${rt}</a>`,
            )
            .join('')}
        </div>
      </section>
    </div>
  `),
  )
}

export async function startServer(config) {
  const app = express()
  // Middleware
  app.use(cors())
  app.use(express.json({ type: ['application/json', 'application/fhir+json'] }))
  app.use(express.urlencoded({ extended: true }))
  config.db = getDb(config.dbPath)
  migrate(config)

  app.use((req, res, next) => {
    req.config = config
    next()
  })

  // Serve static files from the public directory
  app.use(express.static('public'))
  // Handle 404 errors for static content
  app.use((req, res, next) => {
    if (req.path.startsWith('/static') || req.path.startsWith('/assets')) {
      return res.status(404).send('Static resource not found')
    }
    next()
  })

  mountExportRoutes(app)
  mountRunRoutes(app)
  mountEvaluateRoutes(app)
  mountValidateRoutes(app)
  mountViewsRoutes(app)
  // Operation routes must be mounted before the catch-all FHIR routes so
  // that paths like /$sqlquery-run/form are not shadowed by /:resourceType/:id.
  mountSqlQueryRunRoutes(app)
  mountMaterializedViewRoutes(app)
  mountFhirRoutes(app)
  app.get('/', getIndex)
  console.log('Routes mounted')

  return app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`)
  })
}

// Run server if this file is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = {
    port: Number(process.env.PORT) || 30000,
  }

  startServer(config)
}
