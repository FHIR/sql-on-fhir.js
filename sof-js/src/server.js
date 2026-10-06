/**
 * SQL on FHIR reference server.
 *
 * Authors: niquola, jmandel, John Grimes
 */

import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { mountRoutes as mountSqlRunRoutes } from './server/sqlRun.js'
import { mountRoutes as mountSqlExportRoutes, recoverJobs } from './server/sqlExport.js'
import { mountRoutes as mountFhirRoutes } from './server/fhir.js'
import { mountRoutes as mountViewsRoutes } from './server/views.js'
import { mountRoutes as mountValidateRoutes } from './server/validate.js'
import { mountRoutes as mountFormRoutes } from './server/forms.js'
import { migrate, getDb } from './server/db.js'
import { resourceTypes } from './server/utils.js'
import { layout } from './server/ui.js'
import { sendError, operationError, issue } from './server/common.js'
import { DEFAULT_TERMINOLOGY_MAX_MEMBERS, DEFAULT_TERMINOLOGY_SERVER_URL } from './server/terminology.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function getIndex(req, res) {
  const link = (href, text) =>
    `<li><a class="text-blue-500 hover:text-blue-700" href="${href}">${text}</a></li>`
  res.setHeader('Content-Type', 'text/html')
  res.send(
    layout(`
    <div class="container mx-auto p-4">
      <h1 class="text-2xl font-bold mb-4">SQL on FHIR</h1>
      <p class="mb-4">Reference server for the SQL on FHIR operations. Both data operations are invoked at the system level and take a ViewDefinition, SQLQuery Library or SQLView Library as their subject.</p>
      <ul class="list-disc pl-5">
        ${link('/metadata', 'CapabilityStatement')}
        ${link('/$sql-run/form', '$sql-run (synchronous)')}
        ${link('/$sql-export/form', '$sql-export (asynchronous)')}
        ${link('/ViewDefinition', 'ViewDefinitions')}
        ${link('/Library', 'Libraries (SQLQuery and SQLView)')}
        ${link('/Group', 'Groups')}
        ${link('/ViewDefinition/$validate', 'ViewDefinition/$validate')}
        ${link('/Library/$validate/form', 'Library/$validate')}
        <hr class="my-4"/>
        ${resourceTypes
          .slice()
          .sort()
          .map((resourceType) => link(`/${resourceType}`, resourceType))
          .join('\n')}
      </ul>
    </div>
  `),
  )
}

/**
 * Start the server.
 *
 * @param {object} config - `{ port, exportDir?, terminologyServerUrl?, terminologyMaxMembers?, db? }`.
 *   `exportDir` defaults to the `EXPORT_DIR` environment variable, then `./export`;
 *   the terminology settings to `TERMINOLOGY_SERVER_URL` and `TERMINOLOGY_MAX_MEMBERS`,
 *   then the module defaults.
 * @returns {Promise<object>} the listening `http.Server`.
 */
export async function startServer(config) {
  const app = express()
  app.use(cors())
  app.use(express.json({ type: ['application/json', 'application/fhir+json'], limit: '50mb' }))
  // A body that fails to parse is a client error; report it as an
  // OperationOutcome rather than Express's HTML error page.
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return sendError(
        res,
        operationError(400, [issue('structure', `Request body is not valid JSON: ${err.message}`)]),
      )
    }
    next(err)
  })
  app.use(express.urlencoded({ extended: true }))
  config.db = getDb()
  // Terminology server used to resolve ValueSet and ConceptMap dependencies of SQL queries.
  // Explicit config wins over the environment, which wins over the default.
  config.terminologyServerUrl ??= process.env.TERMINOLOGY_SERVER_URL || DEFAULT_TERMINOLOGY_SERVER_URL
  config.terminologyMaxMembers ??=
    Number(process.env.TERMINOLOGY_MAX_MEMBERS) || DEFAULT_TERMINOLOGY_MAX_MEMBERS
  config.exportDir = path.resolve(config.exportDir || process.env.EXPORT_DIR || './export')
  migrate(config)
  recoverJobs(config)

  app.use((req, res, next) => {
    req.config = config
    next()
  })

  app.use(express.static(path.join(__dirname, '..', 'public')))

  // Operation routes are mounted before the catch-all FHIR routes so that
  // paths like /$sql-run are not shadowed by /:resourceType.
  mountSqlRunRoutes(app)
  mountSqlExportRoutes(app)
  mountFormRoutes(app)
  mountValidateRoutes(app)
  mountViewsRoutes(app)
  mountFhirRoutes(app)
  app.get('/', getIndex)

  return app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`)
  })
}

// Run the server when this file is executed directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer({ port: Number(process.env.PORT) || 3000 })
}
