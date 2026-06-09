## ADDED Requirements

### Requirement: Validate a Library against SQLQuery/SQLView rules

The server SHALL provide a `validateSqlLibrary` function that checks a Library
resource against the SQLQuery and SQLView profile rules and returns a structured
list of issues. The function SHALL report an error when any of the following
hold: the `type` code is neither `sql-query` nor `sql-view`; the `type` is
`sql-view` and one or more `parameter` entries are present; any
`content.contentType` does not start with `application/sql`; any `content`
entry has no decodable SQL (`content.data` absent and no `sql-text` extension);
or any `relatedArtifact[depends-on].label` is not a valid SQL identifier. A
conformant SQLQuery and a conformant SQLView SHALL each produce no error issues.

#### Scenario: Conformant SQLQuery has no errors

- **WHEN** a Library of `type` `sql-query` with valid content and dependency
  labels is validated
- **THEN** `validateSqlLibrary` returns no error issues

#### Scenario: Conformant SQLView has no errors

- **WHEN** a Library of `type` `sql-view` with no parameters, valid content, and
  valid dependency labels is validated
- **THEN** `validateSqlLibrary` returns no error issues

#### Scenario: Wrong type reported

- **WHEN** a Library whose `type` code is neither `sql-query` nor `sql-view` is
  validated
- **THEN** an error issue identifying the `type` is returned

#### Scenario: SQLView with parameters reported

- **WHEN** a Library of `type` `sql-view` that declares a `parameter` is
  validated
- **THEN** an error issue identifying the disallowed parameter is returned

#### Scenario: Non-SQL content type reported

- **WHEN** a Library whose `content.contentType` does not start with
  `application/sql` is validated
- **THEN** an error issue identifying the content type is returned

#### Scenario: Missing SQL reported

- **WHEN** a Library whose `content` entry has neither `data` nor a `sql-text`
  extension is validated
- **THEN** an error issue identifying the missing SQL is returned

#### Scenario: Invalid label reported

- **WHEN** a Library whose `relatedArtifact[depends-on].label` is not a valid
  SQL identifier is validated
- **THEN** an error issue identifying the invalid label is returned

### Requirement: Advisory dependency target resolution

The validation SHALL report an error when it can resolve a
`relatedArtifact[depends-on].resource` and the target is neither a
ViewDefinition nor an SQLView, and SHALL report an advisory warning rather than
an error when the canonical cannot be resolved.

#### Scenario: Resolvable target of a disallowed type

- **WHEN** a dependency `resource` resolves to a Library of `type` `sql-query`
- **THEN** an error issue is returned for that dependency target

#### Scenario: Unresolvable target

- **WHEN** a dependency `resource` cannot be resolved to any stored resource
- **THEN** a warning issue (not an error) is returned for that dependency

### Requirement: Pre-flight validation gates execution

`$sqlquery-run` SHALL validate the resolved top-level Library with
`validateSqlLibrary` before execution. When validation returns one or more error
issues, the server SHALL return an HTTP 422 `OperationOutcome` carrying those
issues and SHALL NOT execute the query.

#### Scenario: Malformed Library rejected before execution

- **WHEN** a Library that fails validation is submitted to `$sqlquery-run`
- **THEN** the server returns HTTP 422 with an `OperationOutcome` and does not
  run any SQL

### Requirement: Library $validate endpoint and form

The server SHALL expose a Library `$validate` operation that accepts a Library
resource and returns its validation issues, together with an HTML form that lets
a user paste a Library and view the issues, mirroring the existing
ViewDefinition `$validate` page.

#### Scenario: Validate a posted Library

- **WHEN** a Library resource is posted to the Library `$validate` endpoint
- **THEN** the server returns the validation issues for that Library

#### Scenario: Validate via the form

- **WHEN** a user submits a Library through the Library `$validate` form
- **THEN** the rendered page shows the validation issues

### Requirement: Library list distinguishes queries and views

The Library list page SHALL indicate, for each Library, whether it is an SQL
Query or an SQL View.

#### Scenario: Type shown in list

- **WHEN** the Library list page is rendered with both an `sql-query` and an
  `sql-view` Library present
- **THEN** each row indicates its type
