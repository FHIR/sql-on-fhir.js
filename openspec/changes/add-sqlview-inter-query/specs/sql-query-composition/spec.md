## ADDED Requirements

### Requirement: Resolve dependencies as ViewDefinition or SQLView

When executing a Library via `$sqlquery-run`, the server SHALL resolve each
`relatedArtifact` entry of `type` `depends-on` by its `resource` canonical,
attempting to match a ViewDefinition first and then a Library. A ViewDefinition
match SHALL take precedence over a Library match for the same canonical. If no
ViewDefinition and no Library can be resolved, the server SHALL return HTTP 404
with an `OperationOutcome`.

#### Scenario: Dependency resolves to a ViewDefinition

- **WHEN** a query's `relatedArtifact.resource` matches a ViewDefinition by
  `url` or by trailing id segment
- **THEN** the ViewDefinition is materialised as the labelled table, exactly as
  before this change

#### Scenario: Dependency resolves to an SQLView Library

- **WHEN** a query's `relatedArtifact.resource` matches no ViewDefinition but
  matches a Library of `type` `sql-view`
- **THEN** the SQLView is executed and its result rows are materialised as the
  labelled table

#### Scenario: Dependency cannot be resolved

- **WHEN** a query's `relatedArtifact.resource` matches neither a ViewDefinition
  nor a Library
- **THEN** the server returns HTTP 404 with an `OperationOutcome` naming the
  unresolved resource

### Requirement: Recursive materialisation of SQLView dependencies

The server SHALL execute an SQLView dependency by recursively resolving and
materialising its own `relatedArtifact` dependencies, executing its SQL, and
materialising the resulting rows as a virtual table for the referencing query.
The materialised table's columns SHALL be derived from the view's result-set
column names rather than only from its rows, so that an SQLView returning no
rows still produces a usable table. Recursion SHALL support arbitrary depth (a
view referencing a view referencing a ViewDefinition).

#### Scenario: Query references a view that references a ViewDefinition

- **WHEN** a stored or inline SQLQuery references an SQLView whose own
  dependency is a ViewDefinition
- **THEN** `$sqlquery-run` returns the rows produced by running the query over
  the materialised view output

#### Scenario: Query joins an SQLView and a ViewDefinition

- **WHEN** an SQLQuery declares one `depends-on` referencing an SQLView and
  another referencing a ViewDefinition, and its SQL joins the two labelled
  tables
- **THEN** `$sqlquery-run` returns the joined rows

#### Scenario: Referenced SQLView returns no rows

- **WHEN** a query references an SQLView whose execution yields zero rows
- **THEN** the virtual table is still created from the view's result-set column
  names and `$sqlquery-run` returns zero rows without error

#### Scenario: View references another view (arbitrary depth)

- **WHEN** a query references an SQLView that itself references a second SQLView
  whose dependency is a ViewDefinition
- **THEN** `$sqlquery-run` resolves the full chain and returns the expected rows

### Requirement: SQLView dependency constraints

A `relatedArtifact` dependency that resolves to a Library SHALL be of `type`
`sql-view` and SHALL NOT declare any `parameter` entries. The server SHALL
return HTTP 422 with an `OperationOutcome` when a Library dependency is of any
other type or declares parameters. Nested SQLViews SHALL be executed with no
parameter bindings.

#### Scenario: Library dependency is an SQLQuery

- **WHEN** a `relatedArtifact` dependency resolves to a Library of `type`
  `sql-query`
- **THEN** the server returns HTTP 422 with an `OperationOutcome`

#### Scenario: Library dependency declares parameters

- **WHEN** a `relatedArtifact` dependency resolves to a Library that declares
  one or more `parameter` entries
- **THEN** the server returns HTTP 422 with an `OperationOutcome`

### Requirement: Dependency cycle detection

The server SHALL detect cycles in the dependency graph by tracking the
canonical identity of each Library on the current resolution path. When a
Library that is already on the path is re-encountered, the server SHALL return
HTTP 422 with an `OperationOutcome` whose diagnostic describes the cycle, rather
than recursing indefinitely.

#### Scenario: Direct cycle between two views

- **WHEN** SQLView A depends on SQLView B and SQLView B depends on SQLView A,
  and a query referencing A is run
- **THEN** the server returns HTTP 422 with an `OperationOutcome` naming the
  cycle path

### Requirement: Run an SQLView as a top-level target

`$sqlquery-run` SHALL accept either an `sql-query` or an `sql-view` Library as
its top-level target. When the target is an SQLView, the server SHALL execute
its SQL over its dependencies with no parameter bindings and return the result
in the requested format.

#### Scenario: SQLView run directly

- **WHEN** an SQLView is supplied as the top-level target (by instance route,
  `queryReference`, or `queryResource`)
- **THEN** `$sqlquery-run` returns the view's rows in the requested `_format`

### Requirement: Backward compatibility for ViewDefinition-only queries

The server SHALL preserve the existing behaviour of `$sqlquery-run` for
SQLQuery Libraries whose dependencies are all ViewDefinitions, including
parameter binding and all supported output formats.

#### Scenario: Existing query suite unchanged

- **WHEN** the existing `tests/server/sql.test.js` suite is run against the
  updated server
- **THEN** every case passes without modification
