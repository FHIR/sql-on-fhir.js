# Reference implementation of the SQL on FHIR spec in JavaScript

The SQL on FHIR reference implementation is a guide for anyone writing their
own implementation. It includes the ViewDefinition engine, a validator and a
server that implements the `$sql-run` and `$sql-export` operations from the
[SQL on FHIR](https://build.fhir.org/ig/HL7/sql-on-fhir/) implementation guide
(3.0.0-ballot).

## Setup

This implementation requires [bun](https://bun.sh/). Run `bun install` to fetch
the dependencies.

## Running the tests

```bash
bun test
```

The shared conformance suite in `../tests` runs through `tests/compliance.test.js`.
The server tests under `tests/server/` start the server on a free port; the
first run downloads a small Synthea data set into `db.sqlite`, which is reused
afterwards.

## Running the server

```bash
bun run server
```

The server listens on port 3000 (`PORT` overrides this). On first start it
loads about 100 synthetic patients and their clinical resources from a public
Synthea bundle into SQLite (`DB_PATH`, default `./db.sqlite`), plus the
ViewDefinitions, Libraries, Groups and terminology under `metadata/`.

Browse to `http://localhost:3000/` for the CapabilityStatement, the stored
artifacts and an HTML form for each operation.

## Operations

Both data operations are invoked at the system level and name their subject -
a ViewDefinition, a SQLQuery Library or a SQLView Library - by parameter:
`subjectCanonical`, `subjectReference` (`ViewDefinition/<id>` or
`Library/<id>`) or an inline `subjectResource`. The behaviour follows the
specification's [Common Operation Behavior](https://build.fhir.org/ig/HL7/sql-on-fhir/operations-common.html)
page; the subset this server supports is declared by its own
OperationDefinitions (`metadata/OperationDefinition/sql-run.json` and
`sql-export.json`), whose `base` is the specification's definition.

### `$sql-run`

`GET` or `POST /$sql-run`. Supported parameters: the three subject forms,
`parameters` (bound by name to `Library.parameter`, SQL subjects only),
`context` (inline ViewDefinitions and SQLViews matched to `relatedArtifact`
dependencies by canonical URL), `resource` (inline FHIR resources, Bundles
unwrapped, ViewDefinition subjects only), `_format`, `header`, `patient`,
`group`, `_since` and `_limit`. Formats: `csv`, `json`, `ndjson` (default) and
`fhir`; `Accept: application/fhir+json` returns the flat formats wrapped in a
`Binary` resource. `parquet` and `source` are not supported and are rejected
with `400 not-supported`.

```bash
# A ViewDefinition over GET, filtered to one patient
curl 'http://localhost:3000/$sql-run?subjectReference=ViewDefinition/patient_demographics&patient=Patient/5ab3b247-dc11-35cb-3ed6-8be889f6ccbe&_format=csv'

# A SQLQuery with bound parameters over POST
curl -X POST http://localhost:3000/\$sql-run \
  -H 'Content-Type: application/fhir+json' \
  -d '{"resourceType":"Parameters","parameter":[
        {"name":"subjectReference","valueReference":{"reference":"Library/patient-by-id"}},
        {"name":"parameters","resource":{"resourceType":"Parameters","parameter":[
          {"name":"patient_id","valueString":"5ab3b247-dc11-35cb-3ed6-8be889f6ccbe"}]}},
        {"name":"_format","valueCode":"json"}]}'
```

### `$sql-export`

`POST /$sql-export` with `Prefer: respond-async`. Each repetition of the
`subject` parameter (parts `name`, one of the three subject forms, and
`parameters`) produces one manifest entry; `context`, `clientTrackingId`,
`_format` (`csv`, `json`, `ndjson`; default `ndjson`), `header`, `patient`,
`group` and `_since` apply to the whole job. The request is validated in full
before `202 Accepted` is returned with the status URL in `Content-Location`.

- `GET  /$sql-export/<id>/status` - `202` with `Retry-After` while running,
  `303` to the result URL when finished.
- `DELETE /$sql-export/<id>/status` - cancels the job; later polls return `404`.
- `GET  /$sql-export/<id>/result` - the manifest `Parameters` (`200`) or, for a
  failed job, an `OperationOutcome`.
- `GET  /$sql-export/<id>/<name>.<format>` - downloads an output file.

Jobs are recorded under `EXPORT_DIR` (default `./export`, one directory per
job holding `job.json` and a `files/` directory with the outputs), so completed
manifests and downloads remain available across restarts. Output is never
expired automatically. A job still running when the server stops is reported
as failed on the next start. Every subject is validated and probed against an
empty data set at kick-off, so SQL and FHIRPath errors are rejected with `422`
before a job is created. Subjects are evaluated sequentially on the server's
event loop, so a large export delays other requests while a ViewDefinition is
being evaluated; this is a reference server, not a scalable one.

```bash
curl -i -X POST http://localhost:3000/\$sql-export \
  -H 'Content-Type: application/fhir+json' -H 'Prefer: respond-async' \
  -d '{"resourceType":"Parameters","parameter":[
        {"name":"subject","part":[{"name":"name","valueString":"demographics"},
          {"name":"subjectCanonical","valueCanonical":"http://myig.org/ViewDefinition/patient_demographics"}]},
        {"name":"subject","part":[{"name":"name","valueString":"count"},
          {"name":"subjectReference","valueReference":{"reference":"Library/patient-count"}}]},
        {"name":"_format","valueCode":"csv"}]}'
```

### Filtering

`patient` restricts the resources feeding every view to the Patient
compartments of the named patients, using the FHIR R4
`CompartmentDefinition/patient` (pre-resolved into
`metadata/compartment/patient.json` by `scripts/generatePatientCompartment.js`).
`group` resolves the members of a stored `Group` (fixtures under
`metadata/Group/`) and applies the same rule. `_since` keeps resources whose
`meta.lastUpdated` is after the instant; resources without one are kept.

### ValueSet dependencies

A `relatedArtifact` entry with `type = "depends-on"` on a SQLQuery or SQLView
Library may name a ValueSet by canonical URL, optionally pinned with
`|version`. The value set is exposed to the SQL under the entry's `label` as a
relation with the columns `system`, `version`, `code`, `display` and
`inactive`, one row per member, unique on (`system`, `version`, `code`), as
specified on the "Terminology in SQL" page of the SQL on FHIR Implementation
Guide. Abstract entries in a hierarchical expansion contribute no row; nested
entries are flattened.

```json
"relatedArtifact": [
  { "type": "depends-on", "resource": "http://myig.org/ViewDefinition/conditions", "label": "conditions" },
  { "type": "depends-on", "resource": "http://myig.org/ValueSet/cardiovascular-disease|1.0.0", "label": "cardiovascular_codes" }
]
```

```sql
SELECT DISTINCT conditions.patient_id
FROM conditions
WHERE EXISTS (
  SELECT 1 FROM cardiovascular_codes
  WHERE cardiovascular_codes.system = conditions.system
    AND cardiovascular_codes.code = conditions.code
)
```

Membership is resolved once per request (once per job on `$sql-export`, shared
by every subject), before any SQL runs, in this order:

1. A ValueSet stored in `metadata/ValueSet/` whose `url` (and `version`, where
   pinned) matches. Its `expansion` is used when present; a ValueSet with only
   a `compose` is posted to the terminology server's `$expand`.
2. `GET ValueSet/$expand?url=…` on the terminology server, with
   `valueSetVersion` where pinned, paging with `offset`/`count` until the
   expansion is complete.

A canonical URL that resolves to nothing, or to several stored versions when
unpinned, is rejected with `404 Not Found`. A value set that resolves but whose
membership cannot be determined - a terminology server failure, a stored
expansion that is a page or lists fewer entries than its `total`, or more
members than the configured cap - is rejected with `422 Unprocessable Entity`.
The public `tx.fhir.org` refuses to expand value sets of more than 3000 codes
(`too-costly`), which surfaces as this `422`; point `TERMINOLOGY_SERVER_URL` at
a server without that limit for larger value sets. Each resolution writes one
log line recording the canonical URL, the resolved version, the source, the
expansion identifier and timestamp, the code system versions reported by the
expansion and the member count.

Configuration (environment variables):

| Variable                  | Default                  | Purpose                                              |
| ------------------------- | ------------------------ | ---------------------------------------------------- |
| `TERMINOLOGY_SERVER_URL`  | `https://tx.fhir.org/r4` | Base URL of the FHIR terminology server              |
| `TERMINOLOGY_MAX_MEMBERS` | `100000`                 | Maximum members per value set before a `422` is sent |

A ValueSet cannot be supplied inline through the `context` parameter.

### Server extensions

`POST /ViewDefinition/$validate` and `POST /Library/$validate` validate a
ViewDefinition or a SQLQuery/SQLView Library and return an `OperationOutcome`.
They are not part of the specification.

## Sample artifacts

`metadata/ViewDefinition/` holds `patient_demographics`, `observations`,
`patient_multiple_birth` and `conditions`. `metadata/Library/` holds SQLQuery
Libraries (`patient-count`, `patient-by-id`, `female-patient-births`,
`cardiovascular-patients`, `patients-by-gender`, ...) and SQLView Libraries
(`patient-demographics-view`, `active-female-patients-view`,
`gender-codes-view`, ...), including deliberately broken fixtures used by the
tests (`ghost-dep-query`, `cycle-view-a`/`cycle-view-b`, `parameterised-view`).
`metadata/ValueSet/cardiovascular-disease.json` is a value set with a complete
expansion, used by `cardiovascular-patients`.
