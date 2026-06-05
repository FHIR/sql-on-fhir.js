## Why

The IG (HL7/sql-on-fhir PR #364) introduces an `SQLView` profile and widens
`relatedArtifact.resource` so that an `SQLQuery` or `SQLView` may reference
another `SQLView` as a virtual table, letting queries compose one another. The
JavaScript reference server's `$sqlquery-run` only resolves `relatedArtifact`
dependencies as ViewDefinitions, one level deep, so it cannot execute these
composed queries. This change brings the reference server in line with the
specification.

## What Changes

- `$sqlquery-run` resolves a `relatedArtifact[depends-on]` entry that points to
  an `SQLView` Library (not just a ViewDefinition), recursively executes it, and
  materialises its result rows as a virtual table named by the entry's `label`.
- Resolution tries ViewDefinition first, then Library; existing
  ViewDefinition-only queries behave exactly as before (no breaking change).
- A Library dependency must be `type = sql-view` and declare no parameters;
  otherwise the operation fails. Nested views execute with no parameter
  bindings - parameters remain a top-level-only concept.
- Dependency cycles are detected and reported as an error rather than looping.
- `$sqlquery-run` accepts either an `sql-query` or an `sql-view` Library as its
  top-level target, so a view's output can be previewed directly.
- A reusable `validateSqlLibrary` function checks SQLQuery/SQLView profile
  conformance; it gates execution (pre-flight) and backs a new Library
  `$validate` form, mirroring the existing ViewDefinition `$validate` page.
- Two runnable metadata examples are added: an `SQLView` over
  `patient_demographics`, and an `SQLQuery` composing that view with the
  `patient_multiple_birth` ViewDefinition.
- UI: the Library list distinguishes SQL Query from SQL View, the run form shows
  a query's resolved dependencies, and list/index headings are corrected.

## Capabilities

### New Capabilities

- `sql-query-composition`: how `$sqlquery-run` resolves and executes SQLQuery and
  SQLView Libraries whose `relatedArtifact` dependencies reference ViewDefinitions
  and/or other SQLViews, including recursive materialisation, cycle detection,
  dependency-type enforcement, and running a view as a top-level target.
- `sql-library-validation`: server-side validation of a Library against the
  SQLQuery/SQLView profile rules, exposed both as `$sqlquery-run` pre-flight
  validation and as a standalone Library `$validate` endpoint and form.

### Modified Capabilities

<!-- None: openspec/specs/ is empty; this server has no prior spec coverage. -->

## Acceptance Criteria

- An `SQLQuery` whose `relatedArtifact` references an `SQLView` (which itself
  references a ViewDefinition) returns the expected rows via `$sqlquery-run`,
  for both a stored Library and an inline `queryResource`.
- An `SQLQuery` that joins an `SQLView` and a ViewDefinition returns the joined
  rows.
- Running an `SQLView` directly via `$sqlquery-run` returns the view's rows.
- A query referencing an `SQLView` that itself references another `SQLView`
  (depth 3: query -> view -> view -> ViewDefinition) returns the expected rows,
  exercising arbitrary-depth recursion.
- A query referencing an `SQLView` whose result is empty resolves the virtual
  table and returns zero rows (no error), confirming column derivation does not
  depend on the view producing rows.
- A dependency graph containing a cycle returns HTTP 422 with an
  `OperationOutcome` whose diagnostic names the cycle.
- A `relatedArtifact` referencing a Library that is `sql-query` or that declares
  parameters returns HTTP 422.
- Every existing `tests/server/sql.test.js` case continues to pass unchanged,
  including under the new pre-flight validation gate (existing fixtures are
  conformant, and an unresolvable dependency yields a warning, not an error, so
  the existing 404 path is preserved). The suite is run with `npm test` (Jest),
  not `bun test`.
- `validateSqlLibrary` returns no errors for a conformant SQLQuery and a
  conformant SQLView, and returns the expected error issues for: wrong `type`,
  an SQLView with a parameter, a `content.contentType` not starting with
  `application/sql`, missing `content.data`, and an invalid SQL-identifier
  `label`.
- A malformed Library submitted to `$sqlquery-run` is rejected with an
  `OperationOutcome` before execution.
- The Library `$validate` endpoint returns the validation issues for a posted
  Library.
- The Library list page shows whether each row is an SQL Query or an SQL View.

## Impact

- `sof-js/src/server/sql.js`: dependency resolution, recursive materialisation,
  cycle detection, pre-flight validation, list/run-form UI.
- `sof-js/src/server/validate.js` (or a new `sqlLibraryValidation.js`):
  `validateSqlLibraryShape` (pure) and `validateSqlLibrary` (composes the shape
  checks with advisory resolution), plus Library `$validate` form and endpoints.
- `sof-js/metadata/Library/`: two new example resources.
- `sof-js/metadata/OperationDefinition/$sqlquery-run.json`: description update,
  plus a Library-scoped `$validate` OperationDefinition so the new form renders
  accurate metadata.
- `sof-js/tests/server/sql.test.js` and a new validation unit test file (the
  test suite runs under Jest via `npm test`).
- `README.md`: brief mention of SQLView/composition support.
- No new runtime dependencies (continues to use the bundled `sqlite3`).

Out of scope but adjacent (separate commit): `sof-js/src/server/validate.js`
has a pre-existing bug in `POST /ViewDefinition/$validate` - it calls
`req.body.json()` (incorrect under Express) and echoes the resource without
validating. It will be fixed alongside this work in its own commit so the two
`$validate` endpoints behave consistently.
