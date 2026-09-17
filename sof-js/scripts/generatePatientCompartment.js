/**
 * Generates metadata/compartment/patient.json from the FHIR R4 Patient
 * CompartmentDefinition and the R4 SearchParameter bundle.
 *
 * Usage (from sof-js/):
 *
 *   bun scripts/generatePatientCompartment.js [compartmentdefinition-patient.json] [search-parameters.json]
 *
 * Both arguments are optional local file paths; when omitted the R4 artefacts
 * are downloaded from hl7.org. The resulting table maps each resource type to
 * the sorted, de-duplicated dot paths (relative to the resource) at which a
 * Reference to a Patient may appear.
 *
 * Any search parameter expression that cannot be normalised into a plain dot
 * path of identifiers causes the script to exit non-zero, so that nothing is
 * silently omitted from the table.
 *
 * Author: John Grimes
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const COMPARTMENT_URL = 'https://hl7.org/fhir/R4/compartmentdefinition-patient.json'
const SEARCH_PARAMETERS_URL = 'https://hl7.org/fhir/R4/search-parameters.json'
const GENERATION_COMMAND = 'bun scripts/generatePatientCompartment.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.join(__dirname, '..', 'metadata', 'compartment', 'patient.json')

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Load JSON either from a local path or, when no path is given, from a URL.
 *
 * @param {string | undefined} localPath optional local file path.
 * @param {string} url fallback URL.
 * @returns {Promise<object>} the parsed JSON.
 */
async function loadJson(localPath, url) {
  if (localPath) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'))
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

/**
 * Strip a balanced `.name(...)` function call from the start of `rest`.
 * Returns the argument text and the remainder, or null when `rest` does not
 * begin with a call to the named function.
 *
 * @param {string} rest the remaining expression text.
 * @param {string} name the function name.
 * @returns {{ arg: string, rest: string } | null}
 */
function takeCall(rest, name) {
  const prefix = `.${name}(`
  if (!rest.startsWith(prefix)) return null
  let depth = 0
  for (let i = prefix.length - 1; i < rest.length; i++) {
    if (rest[i] === '(') depth++
    else if (rest[i] === ')') {
      depth--
      if (depth === 0) {
        return { arg: rest.slice(prefix.length, i), rest: rest.slice(i + 1) }
      }
    }
  }
  return null
}

/**
 * Translate one FHIRPath alternative into a dot path relative to the resource.
 * Returns null when the alternative applies to a different resource type.
 *
 * @param {string} resourceType the resource type being translated.
 * @param {string} alternative one `|`-separated alternative of the expression.
 * @returns {string | null} the dot path, or null when not applicable.
 */
function translateAlternative(resourceType, alternative) {
  const prefix = `${resourceType}.`
  if (!alternative.startsWith(prefix)) return null

  const segments = []
  let rest = alternative.slice(prefix.length - 1)
  while (rest.length > 0) {
    let call
    if ((call = takeCall(rest, 'where'))) {
      rest = call.rest
      continue
    }
    if ((call = takeCall(rest, 'resolve'))) {
      if (call.arg.trim() !== '') throw new Error(`unexpected argument to resolve(): ${alternative}`)
      rest = call.rest
      continue
    }
    if ((call = takeCall(rest, 'as')) || (call = takeCall(rest, 'ofType'))) {
      const type = call.arg.trim()
      if (!IDENTIFIER.test(type) || segments.length === 0) {
        throw new Error(`cannot translate type cast: ${alternative}`)
      }
      segments[segments.length - 1] += type[0].toUpperCase() + type.slice(1)
      rest = call.rest
      continue
    }
    const match = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
    if (!match || rest[match[0].length] === '(') {
      throw new Error(`cannot translate expression: ${alternative}`)
    }
    segments.push(match[1])
    rest = rest.slice(match[0].length)
  }
  if (segments.length === 0) throw new Error(`empty path: ${alternative}`)
  return segments.join('.')
}

/**
 * Translate a SearchParameter expression into the dot paths that apply to the
 * given resource type.
 *
 * @param {string} resourceType the resource type.
 * @param {string} expression the FHIRPath search parameter expression.
 * @returns {string[]} the applicable dot paths.
 */
function translateExpression(resourceType, expression) {
  const paths = expression
    .split('|')
    .map((alternative) => translateAlternative(resourceType, alternative.trim()))
    .filter((p) => p !== null)
  if (paths.length === 0) {
    throw new Error(`no alternative applies to ${resourceType}: ${expression}`)
  }
  return paths
}

/**
 * Build the compartment table.
 *
 * @param {object} compartment the Patient CompartmentDefinition.
 * @param {object} searchParameters the SearchParameter Bundle.
 * @returns {Record<string, string[]>} resource type to sorted dot paths.
 */
function buildTable(compartment, searchParameters) {
  const parameters = searchParameters.entry.map((e) => e.resource)
  const table = {}
  for (const entry of compartment.resource) {
    if (!entry.param || entry.param.length === 0) continue
    const paths = new Set()
    for (const code of entry.param) {
      const matches = parameters.filter((sp) => sp.code === code && (sp.base || []).includes(entry.code))
      if (matches.length !== 1) {
        throw new Error(
          `${entry.code}: expected exactly one SearchParameter with code '${code}', found ${matches.length}`,
        )
      }
      const [parameter] = matches
      if (!parameter.expression) {
        throw new Error(`${entry.code}: SearchParameter '${code}' has no expression`)
      }
      for (const p of translateExpression(entry.code, parameter.expression)) paths.add(p)
    }
    table[entry.code] = [...paths].sort()
  }
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

async function main() {
  const [compartmentPath, searchParametersPath] = process.argv.slice(2)
  const compartment = await loadJson(compartmentPath, COMPARTMENT_URL)
  const searchParameters = await loadJson(searchParametersPath, SEARCH_PARAMETERS_URL)
  const table = buildTable(compartment, searchParameters)
  const output = {
    _comment: `Generated by '${GENERATION_COMMAND}' from ${COMPARTMENT_URL} and ${SEARCH_PARAMETERS_URL}. Do not edit by hand.`,
    ...table,
  }
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n')
  console.log(`Wrote ${Object.keys(table).length} resource types to ${OUTPUT_PATH}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
