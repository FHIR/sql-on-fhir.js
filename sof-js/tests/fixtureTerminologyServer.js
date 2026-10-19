/**
 * A FHIR terminology endpoint that answers value set membership from ValueSet
 * fixtures, so that fhirpath.js can evaluate `memberOf` without a real
 * terminology server. It serves the two requests fhirpath.js makes:
 *
 * - `GET ValueSet?url=<url>[|version]`, a search by canonical URL;
 * - `GET` and `POST ValueSet/$validate-code`, for a `code` and `system`, a
 *   `coding` or a `codeableConcept`, in the value set named by `url`.
 *
 * Each named suite of fixtures is served under its own path prefix. fhirpath.js
 * caches responses by request URL for the life of the process, so a prefix per
 * suite keeps the answers for one suite from being served to another.
 *
 * Membership is exactly the (`system`, `code`) pairs in `expansion.contains`,
 * at any depth. A canonical URL resolves when exactly one fixture matches its
 * `url`, and its `version` where the canonical carries a `|version` suffix.
 *
 * Author: John Grimes
 */

import http from 'http'

// The fixtures named by a canonical URL, which may carry a `|version` suffix.
function matching(valueSets, canonical) {
  const [url, version] = (canonical ?? '').split('|')
  return valueSets.filter((vs) => vs.url === url && (version === undefined || vs.version === version))
}

// Visit every `contains` entry of an expansion at any depth.
function* walkContains(entries) {
  for (const entry of entries || []) {
    yield entry
    yield* walkContains(entry.contains)
  }
}

// Whether any of the codings is in the expansion of the value set.
function anyMember(valueSet, codings) {
  const members = [...walkContains(valueSet.expansion?.contains)]
  return codings.some((coding) => members.some((m) => m.system === coding.system && m.code === coding.code))
}

// The canonical URL and codings of a `$validate-code` request.
function validateCodeRequest(method, query, body) {
  if (method === 'GET') {
    return {
      canonical: query.get('url'),
      codings: [{ system: query.get('system'), code: query.get('code') }],
    }
  }
  const parameter = JSON.parse(body).parameter || []
  const part = (name) => parameter.find((p) => p.name === name)
  const codings = part('codeableConcept')
    ? part('codeableConcept').valueCodeableConcept.coding || []
    : part('coding')
      ? [part('coding').valueCoding]
      : [{ system: part('system')?.valueUri, code: part('code')?.valueCode }]
  return { canonical: part('url')?.valueUri, codings }
}

function respond(res, status, resource) {
  res.writeHead(status, { 'Content-Type': 'application/fhir+json' })
  res.end(JSON.stringify(resource))
}

function notFound(res, diagnostics) {
  respond(res, 404, {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'not-found', diagnostics }],
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

/**
 * Start the endpoint on an ephemeral port.
 *
 * @param {Object<string, object[]>} suites - ValueSet fixtures keyed by suite name.
 * @returns {Promise<{urlFor: (name: string) => string, close: () => Promise<void>}>} a function giving
 *   the terminology server base URL for a suite, and a shutdown function.
 * @example
 * const tx = await startFixtureTerminologyServer({ 'fn_memberof.json': valueSets })
 * await evaluate(view, resources, true, { terminologyUrl: tx.urlFor('fn_memberof.json') })
 * await tx.close()
 */
export async function startFixtureTerminologyServer(suites) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const [, prefix, ...rest] = url.pathname.split('/')
    const valueSets = suites[decodeURIComponent(prefix)]
    const path = '/' + rest.join('/')
    const body = req.method === 'POST' ? await readBody(req) : null

    if (!valueSets) return notFound(res, `Unknown suite ${prefix}`)

    if (path === '/ValueSet' && req.method === 'GET') {
      const matches = matching(valueSets, url.searchParams.get('url'))
      return respond(res, 200, {
        resourceType: 'Bundle',
        type: 'searchset',
        total: matches.length,
        entry: matches.map((resource) => ({ resource, search: { mode: 'match' } })),
      })
    }

    if (path === '/ValueSet/$validate-code') {
      const { canonical, codings } = validateCodeRequest(req.method, url.searchParams, body)
      const matches = matching(valueSets, canonical)
      if (matches.length !== 1) return notFound(res, `Value set ${canonical} cannot be resolved`)
      return respond(res, 200, {
        resourceType: 'Parameters',
        parameter: [{ name: 'result', valueBoolean: anyMember(matches[0], codings) }],
      })
    }

    notFound(res, `Unknown path ${path}`)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    urlFor: (name) => `${base}/${encodeURIComponent(name)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        // fetch keeps connections alive, which would otherwise hold `close` open.
        server.closeAllConnections()
      }),
  }
}
