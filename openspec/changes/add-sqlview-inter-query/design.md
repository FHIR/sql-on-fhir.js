## Context

The reference server (`sof-js/`) implements `$sqlquery-run` in
`src/server/sql.js`. Today `materialiseDependencies` resolves each
`relatedArtifact[depends-on]` entry only as a ViewDefinition (`resolveViewDefinition`),
derives its columns from the ViewDefinition's declared `select` tree, creates a
SQLite temp table, runs the engine's `evaluate()` to populate it, then executes
the Library's SQL with bound parameters. Resolution is one level deep and there
is no Library-to-Library composition.

IG PR #364 adds an `SQLView` profile (a `Library` of `type` `sql-view`, no
parameters) and widens `relatedArtifact.resource` on both `SQLQuery` and
`SQLView` to `Canonical(ViewDefinition or SQLView)`. This design brings the
server's execution and validation in line, and surfaces the feature in the UI.

Constraints: stay within the existing in-memory `sqlite3` machinery; no new
runtime dependencies; preserve all current `$sqlquery-run` behaviour; follow the
project's functional style (no classes beyond the existing `SqlQueryRunError`).

## Goals / Non-Goals

**Goals:**

- Resolve and recursively execute SQLView dependencies, materialising their rows
  as virtual tables for the referencing query.
- Detect dependency cycles and fail clearly.
- Allow an SQLView to be run directly as a top-level target.
- Validate Library conformance once, reused for pre-flight and a standalone
  endpoint/form.
- Demonstrate the feature with runnable metadata examples and update the UI.

**Non-Goals:**

- Inlining dependencies as SQLite views/CTEs (we materialise instead).
- Parameterised views or passing parameters into nested queries.
- Caching or persisting materialised intermediate results across requests.
- Re-validating ViewDefinitions (the existing engine `errors()` already covers
  that); this change validates only SQLQuery/SQLView Libraries.

## Decisions

**Recursive materialisation into temp tables.** Each Library dependency is run in
its own in-memory SQLite database; its result rows are then `INSERT`ed into the
parent database under the dependency `label`. This mirrors the existing
ViewDefinition path and keeps each query level's label namespace isolated.
Alternative (SQLite `VIEW`/CTE inlining) was rejected: nested SQL references its
own labelled base tables, which would then have to co-exist in one database,
risking label collisions across levels and complicating `_format=fhir` typing.

**ViewDefinition-first resolution.** `resolveDependency(resource)` tries
`resolveViewDefinition` first, then a Library resolver (by `url`, then trailing
id segment). ViewDefinition wins a tie. This guarantees zero behavioural change
for existing ViewDefinition-only queries.

**Column derivation and typing for materialised views.** A ViewDefinition
arrives with declared column types that drive temp-table affinity and FHIR
output typing. An SQLView has no declared columns, so we derive its table from
the view's _result-set column names_ (the keys its SQL produces), not merely
from its rows. This matters for the empty-result case: a view that returns zero
rows still has a known column list, so we can `CREATE TABLE` with the right
columns and the referencing query's `SELECT ... FROM <label>` still resolves.
Concretely, after running the view in its own database we take column names from
the first row when present, else introspect the view's own SQL with a
`SELECT * FROM (<sql>) LIMIT 0` against that database to recover the column
names. All materialised view columns get default `TEXT` affinity (SQLite coerces
on read), which is sufficient because flat-format output is value-driven and
`_format=fhir` typing is handled separately (below).

SQLView dependencies are deliberately _not_ added to `labelToColumns`. That map
carries declared FHIR column types for the existing ViewDefinition path; an
SQLView has none, and the runtime `typeof()` probe already in
`resolveColumnFhirTypes` types computed columns for `_format=fhir`. Populating
`labelToColumns` with SQLite runtime-type strings (`text`/`real`/`blob`/`null`)
would conflate two vocabularies (FHIR types vs SQLite runtime types) and only
work by accident of the fall-through in `chooseFhirValueField`. Leaving SQLView
columns out keeps a single typing path and fewer moving parts.

**Cycle detection via a path set.** A `Set` of canonical keys
(`library.url` else `Library/<id>` else an inline sentinel) is threaded through
the recursion. Re-entering a key on the current path throws a 422 naming the
cycle. Chosen over a bare depth cap because the error is precise and a deep but
valid graph is not penalised.

**Strict Library dependency type.** A Library dependency must be `type=sql-view`
with no parameters, else 422. This matches the spec's `targetProfile`
(ViewDefinition or SQLView) and SQLView's `0..0` parameter rule. Top-level
targets may be `sql-query` or `sql-view`. The verified IG diff (`relatedArtifact.resource only Canonical(ViewDefinition or SQLView)`) confirms an
SQLQuery may not be a dependency, only a top-level target. `Library.type` is a
`CodeableConcept`, so the code is read from `type.coding[].code` (matching any
coding; the `LibraryTypesCodes` system is the expected source).

**One validation function, split for testability.** A pure
`validateSqlLibraryShape(library)` performs the Library-only checks (type,
sql-view parameters, content type, SQL presence, label) with no I/O. A thin
`validateSqlLibrary(library, config)` composes it with the advisory,
`config`-backed dependency-target resolution and returns the combined issues. It
is the single source of truth, called as `$sqlquery-run` pre-flight and behind
the Library `$validate` endpoint/form. The split lets the shape rules be
unit-tested directly while the resolution branch is tested against a stub
`config`.

## Contracts / External Interfaces

### `$sqlquery-run` (modified behaviour, same shape)

Request and response shapes are unchanged. New behaviour:

- A `relatedArtifact[depends-on].resource` may now resolve to a `Library` of
  `type` `sql-view`, which is executed recursively and materialised as the
  table named by `label`.
- The top-level target (instance route id, `queryReference`, or `queryResource`)
  may be an `sql-query` or an `sql-view` Library.
- New error responses, all `OperationOutcome`:
  - `404 not-found` - a dependency resolves to neither ViewDefinition nor Library.
  - `422 invalid` - a Library dependency is not `sql-view`, or declares parameters.
  - `422 processing` (or `invalid`) - a dependency cycle is detected; diagnostic
    contains the cycle path, e.g. `A -> B -> A`.
  - `422` with validation issues - the top-level Library fails pre-flight
    `validateSqlLibrary`.

### Library `$validate` (new)

- `POST /Library/$validate` - body is a FHIR `Library` (`application/fhir+json`);
  response is an `OperationOutcome` whose `issue` array carries one entry per
  validation finding (`severity` `error` or `warning`, `code`, `diagnostics`,
  and an `expression` pointing at the offending element where known). An empty
  (or all-`information`) issue list denotes a conformant Library.
- `GET /Library/$validate` - HTML form (see UI Screens).
- `POST /Library/$validate/form` - form submission; renders the issues as HTML.

### `validateSqlLibrary(library, config)` (library entry point)

Returns `Promise<Issue[]>` where `Issue = { severity, code, diagnostics, expression? }`.
It is _not_ pure: it performs advisory dependency-target resolution via `config`
(db reads). The pure Library-only checks live in `validateSqlLibraryShape(library)`,
which `validateSqlLibrary` composes with the resolution step. No throwing for
validation findings - findings are returned as data.

## UI Screens

### Library list (`GET /Library`) - modified

Adds a Type column distinguishing SQL Query from SQL View, and corrects the
heading. Both types remain runnable.

```
Home /
------------------------------------------------------------
SQL libraries                                  [ $sqlquery-run ]
------------------------------------------------------------
 Name                  Type        Title            URL        Run
 active-female-...     SQL View    Active Females   http://..  $sqlquery-run
 female-patient-...    SQL Query   Female Births    http://..  $sqlquery-run
 patient-count         SQL Query   Patient Count    http://..  $sqlquery-run
```

States: populated (above); empty (table with no rows under the headers).

### `$sqlquery-run` instance form (`GET /Library/:id/$sqlquery-run/form`) - modified

Adds a read-only "Dependencies" panel listing each resolved `relatedArtifact`:
its `label`, the resolved kind (ViewDefinition or SQLView), and the target.

```
Home / Library / female-patient-births / $sqlquery-run
------------------------------------------------------------
SQLQuery Run

Dependencies (virtual tables)
  label            kind            target
  female_patients  SQLView         http://myig.org/Library/active-female-...
  births           ViewDefinition  http://myig.org/ViewDefinition/patient_multiple_birth

Library parameters
  (this Library declares no parameters)

Output
  _format [ json v ]   header [x]
  [ Run ]
------------------------------------------------------------
#sqlquery-result  (loading -> result <pre> | error panel)
```

States: dependencies resolved (above); a dependency unresolved (row shows the
unresolved target with a muted "unresolved" note); result loading; result
success (`<pre>` of rows); result error (red panel - reuses existing
`sendFormError`).

### Library `$validate` form (`GET /Library/$validate`) - new

Mirrors the existing ViewDefinition `$validate` page: a textarea pre-filled with
a sample Library, an Evaluate button, and a results pane.

```
Home / Library / $validate
------------------------------------------------------------
 Resource (Library JSON)            |  Result
 +------------------------------+   |  +-----------------------+
 | { "resourceType":"Library",  |   |  | [ ] no errors         |
 |   "type": { ... },           |   |  |  - error: SQLView ... |
 |   ... }                      |   |  |  - warning: ...       |
 +------------------------------+   |  +-----------------------+
 [ Evaluate ]
```

States: initial (sample resource, empty result); valid (result shows "no
errors"); invalid (result lists error/warning issues); bad JSON (red error
panel, reusing the existing pattern from `validate.js`).

## Risks / Trade-offs

- [Recomputing a shared view multiple times in one query graph is wasteful] →
  Acceptable for a reference implementation prioritising clarity; result sets are
  small. A per-request memo keyed by canonical could be added later without
  changing the contract.
- [Inferred column types for view results may mis-type `_format=fhir` output
  for all-null columns] → The existing `chooseFhirValueField` returns `null` for
  null columns and those values are omitted from the FHIR output, matching the
  current ViewDefinition behaviour.
- [Cycle key relies on `url`/`id`; an inline top-level Library lacking both gets
  a sentinel key] → Inline targets cannot be referenced by canonical, so they
  cannot participate in a cycle as a dependency; the sentinel only guards the
  top-level frame.
- [ViewDefinition-first resolution could shadow a Library that shares a
  canonical with a ViewDefinition] → This is the intended precedence and matches
  pre-change behaviour; canonicals are expected to be unique per resource type.
- [Pre-flight `validateSqlLibrary` is a new gate on *every* `$sqlquery-run` call,
  so a too-strict rule could break previously passing requests] → All existing
  fixtures are conformant, so the gate is a no-op for them. Two invariants keep
  it that way and must hold: (1) an unresolvable dependency is an advisory
  _warning_, never an error, so the existing 404 execution path is still reached;
  (2) the unresolved-dependency 404 diagnostic still contains the word
  "ViewDefinition", which an existing test asserts. Both are covered by tests in
  this change.
- [An SQLView that returns zero rows has no rows to infer columns from] →
  Resolved by deriving the materialised table from the view's result-set column
  names (see the column-derivation decision), not from rows, so an empty view
  still yields a usable table.

## Migration Plan

Additive change with no data migration. Existing stored Libraries and the test
suite continue to work unchanged. Rollback is reverting the commit(s); no
persisted state is altered (materialised tables are per-request and in-memory).

## Open Questions

None outstanding - the design decisions above were resolved during planning.
