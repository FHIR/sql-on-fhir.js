## 1. Validation tests (TDD)

- [x] 1.1 Add a unit test file for the pure validation core (no config/db) asserting: no errors for a conformant SQLQuery and a conformant SQLView; error for wrong `type` (read from `type.coding[].code`); error for an SQLView with a `parameter`; error for a `content.contentType` not starting with `application/sql`; error for missing SQL (no `data`, no `sql-text`); error for an invalid SQL-identifier `label`
- [x] 1.2 Add validation tests for advisory target resolution, passing a lightweight in-memory `config` stub for `search`/`read`: error when a dependency resolves to an `sql-query` Library; warning (not error) when a dependency canonical is unresolvable
- [x] 1.3 Add integration cases to `tests/server/sql.test.js` (boot the server, POST via `fetch`, as the existing suite does) for the Library `$validate` endpoint happy and sad paths
- [x] 1.4 Run the new validation tests and confirm they fail only on assertions (not import/syntax errors)

## 2. Validation implementation

- [x] 2.1 Implement a pure `validateSqlLibraryShape(library)` (type via `type.coding[].code`, sql-view parameters, content type, SQL presence, label) and a thin `validateSqlLibrary(library, config)` that composes it with the advisory `config`-backed target resolution; `validateSqlLibrary` returns the combined structured issues
- [x] 2.2 Add `POST /Library/$validate`, `GET /Library/$validate`, and `POST /Library/$validate/form` endpoints and the HTML form, mirroring the ViewDefinition `$validate` page; mount the routes ahead of the FHIR catch-all. `POST /Library/$validate` returns an `OperationOutcome` (note: the existing `POST /ViewDefinition/$validate` only echoes its input - see task 7.5)
- [x] 2.3 Run the validation tests and confirm they pass

## 3. Composition tests (TDD)

- [ ] 3.1 Add `tests/server/sql.test.js` cases: SQLQuery -> SQLView -> ViewDefinition returns expected rows (stored Library and inline `queryResource`)
- [ ] 3.2 Add a case for an SQLQuery that joins an SQLView and a ViewDefinition
- [ ] 3.3 Add a case for running an SQLView directly via `$sqlquery-run`
- [ ] 3.4 Add a depth-3 case (SQLQuery -> SQLView -> SQLView -> ViewDefinition) to exercise the "arbitrary depth" requirement, not just a single view level
- [ ] 3.5 Add a case for an SQLView whose result is empty: the referencing query still resolves the table and returns zero rows (see design decision on column derivation for empty views)
- [ ] 3.6 Add error cases: dependency cycle -> 422 naming the cycle; Library dependency of `type` `sql-query` -> 422; Library dependency declaring parameters -> 422; unresolvable dependency -> 404. Assert the unresolvable-dependency diagnostic still contains the word "ViewDefinition" so the existing 404 test continues to pass
- [ ] 3.7 Run the composition tests and confirm they fail only on assertions

## 4. Composition implementation

- [ ] 4.1 Add a Library resolver (by `url`, then trailing id segment) and `resolveDependency(config, resource)` that tries ViewDefinition first, then Library
- [ ] 4.2 Extract `runLibraryToRows(library, config, stack)`: cycle-check, validate (single source of truth for the `sql-view`-type and no-parameters checks), own in-memory DB, recurse via `materialiseDependencies`, `extractSql`, run unbound, return rows and column names, close DB
- [ ] 4.3 Rework `materialiseDependencies(library, config, db, stack)` to branch on dependency kind: ViewDefinition (existing path, declared column types) vs SQLView Library (run recursively). Derive the materialised table's columns from the view's result-set column names, not only from rows, so an empty view still creates a usable table (see design decision); do NOT add inferred SQLView columns to `labelToColumns` - leave `_format=fhir` typing to the existing runtime `typeof()` probe in `resolveColumnFhirTypes`
- [ ] 4.4 Add cycle detection via a path `Set` of canonical keys, returning 422 with the cycle path
- [x] 4.5 Wire pre-flight `validateSqlLibrary` into `$sqlquery-run` so error issues short-circuit to a 422 `OperationOutcome` before execution. Verify the new gate does not change the outcome of any existing fixture (all are conformant): unresolvable deps must yield a warning (not error) so the 404 execution path is still reached
- [ ] 4.6 Allow an `sql-view` Library as a top-level `$sqlquery-run` target
- [ ] 4.7 Run the composition tests and confirm they pass

## 5. Metadata examples

- [ ] 5.1 Add `metadata/Library/active-female-patients-view.json` (SQLView over `patient_demographics`)
- [ ] 5.2 Add `metadata/Library/female-patient-births.json` (SQLQuery joining the SQLView and the `patient_multiple_birth` ViewDefinition)
- [ ] 5.3 Verify both examples load on startup and run end-to-end via `$sqlquery-run`
- [ ] 5.4 Add a Library-scoped `metadata/OperationDefinition/Library-$validate.json` (or equivalent) so the `$validate` form renders accurate metadata, rather than reusing the ViewDefinition-scoped `$validate` definition

## 6. UI

- [ ] 6.1 Add a Type column/badge (SQL Query vs SQL View) to the Library list and correct the list/index headings
- [ ] 6.2 Render the resolved `relatedArtifact` dependencies (label, kind, target) on the `$sqlquery-run` instance form, including an unresolved-dependency state
- [x] 6.3 Confirm the Library `$validate` form renders and reports issues (links from the Library area)

## 7. Docs and verification

- [ ] 7.1 Update `metadata/OperationDefinition/$sqlquery-run.json` description to note composition of ViewDefinitions and SQLViews
- [ ] 7.2 Update `README.md` with a brief mention of SQLView and query composition support
- [ ] 7.3 Run the full Jest suite (`npm test`, which runs `jest`) and `npm run validate`; confirm all pass and no existing test was modified to pass
- [ ] 7.4 Capture a screenshot of the updated Library list, the run form dependencies panel, and the Library `$validate` page using the agent-browser skill
- [ ] 7.5 (Separate commit) Fix the pre-existing `POST /ViewDefinition/$validate` bug in `validate.js`: it calls `req.body.json()` (wrong under Express, where `req.body` is already parsed) and echoes the resource without validating. Make it validate and return an `OperationOutcome`, consistent with the new Library `$validate`
