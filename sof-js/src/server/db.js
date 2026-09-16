/**
 * SQLite-backed resource store. Canonical artifacts (ViewDefinitions,
 * Libraries, OperationDefinitions, terminology and Group fixtures) are loaded
 * from `metadata/`; clinical data is fetched once from the Synthea bundle.
 *
 * Authors: niquola, jmandel, John Grimes
 */

import sqlite3 from 'sqlite3'
import { readResourcesFromDirectory, getFHIRData, resourceTypes } from './utils.js'
import fs from 'fs'
import path from 'path'

/** Resource types loaded from `metadata/<Type>/` at start-up. */
export const CANONICAL_TYPES = [
  'ViewDefinition',
  'OperationDefinition',
  'CodeSystem',
  'ValueSet',
  'Library',
  'Group',
]

export function getDb() {
  const dbPath = process.env.DB_PATH || './db.sqlite'
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }
  return new sqlite3.Database(dbPath)
}

// Table names are quoted because some resource types (Group) are SQL keywords.
function table(resourceType) {
  return `"${resourceType.toLowerCase()}"`
}

function loadCanonicalResources(config, resourceType) {
  const db = config.db
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ${table(resourceType)} ( id text PRIMARY KEY, resource JSON);`)
    const resources = readResourcesFromDirectory(resourceType) || []
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${table(resourceType)} (id, resource) VALUES (?, ?)`)
    resources.forEach((resource) => {
      stmt.run(resource.id, JSON.stringify(resource))
    })
    stmt.finalize()
  })
}

async function loadResources(config, resourceType) {
  const db = config.db
  db.serialize(async () => {
    db.run(`CREATE TABLE IF NOT EXISTS ${table(resourceType)} ( id text PRIMARY KEY, resource JSON);`)
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${table(resourceType)} (id, resource) VALUES (?, ?)`)
    const count = await select(config, `SELECT COUNT(*) as count FROM ${table(resourceType)}`)
    if (count[0].count > 0) {
      stmt.finalize()
      return
    }
    const resources = await getFHIRData(resourceType)
    resources.forEach((resource) => {
      stmt.run(resource.id, JSON.stringify(resource))
    })
    console.log(`Loaded ${resources.length} ${resourceType} resources`)
    stmt.finalize()
  })
}

export async function migrate(config) {
  CANONICAL_TYPES.forEach((resourceType) => {
    loadCanonicalResources(config, resourceType)
  })

  resourceTypes.forEach(async (resourceType) => {
    await loadResources(config, resourceType)
  })
}

export async function select(config, query, params = []) {
  return new Promise((resolve, reject) => {
    config.db.all(query, params, (err, rows) => {
      if (err) {
        reject(err)
      } else {
        resolve(rows)
      }
    })
  })
}

export async function search(config, resourceType, limit = 100) {
  if (!(await tableExists(config, resourceType))) return []
  const rows = await select(config, `SELECT resource FROM ${table(resourceType)} LIMIT ${Number(limit)}`)
  return rows.map((row) => JSON.parse(row.resource))
}

/**
 * Return every stored resource of a type; an empty list when the type has no
 * table.
 *
 * @param {object} config - Server config.
 * @param {string} resourceType - FHIR resource type.
 * @returns {Promise<object[]>} the resources.
 */
export async function searchAll(config, resourceType) {
  if (!(await tableExists(config, resourceType))) return []
  const rows = await select(config, `SELECT resource FROM ${table(resourceType)}`)
  return rows.map((row) => JSON.parse(row.resource))
}

export async function tableExists(config, resourceType) {
  const rows = await select(config, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [
    resourceType.toLowerCase(),
  ])
  return rows.length > 0
}

export async function read(config, resourceType, id) {
  if (!(await tableExists(config, resourceType))) return null
  const rows = await select(config, `SELECT resource FROM ${table(resourceType)} WHERE id = ?`, [id])
  return rows.length > 0 ? JSON.parse(rows[0].resource) : null
}

/**
 * Expand a stored ValueSet using the stored CodeSystem it composes from. When
 * the include lists concepts explicitly the expansion is restricted to them.
 *
 * @param {object} config - Server config.
 * @param {string} valueSetUrl - Canonical URL of the ValueSet.
 * @returns {Promise<object|null>} the ValueSet with a `concept` list, or null when unknown.
 */
export async function expandValueSet(config, valueSetUrl) {
  const valueSet = (await searchAll(config, 'ValueSet')).find((v) => v.url === valueSetUrl)
  if (!valueSet) return null
  const include = valueSet.compose?.include?.[0]
  const codeSystem = (await searchAll(config, 'CodeSystem')).find((c) => c.url === include?.system)
  if (!codeSystem) return valueSet
  const listed = include.concept ? new Set(include.concept.map((c) => c.code)) : null
  valueSet.concept = listed ? codeSystem.concept.filter((c) => listed.has(c.code)) : codeSystem.concept
  return valueSet
}
