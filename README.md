# SQL on FHIR.js

This repository holds the tooling and conformance material for the
[SQL on FHIR](https://sql-on-fhir.org/) specification:

- `sof-js/` - the JavaScript reference implementation (engine, validator and
  server).
- `tests/` - the shared JSON test suite that implementations run against.
- `tests.schema.json` - the JSON Schema describing the test file format.
- `test_report/` - the site that visualises implementation test results and
  hosts the interactive playground.

The specification itself (the HL7 FHIR Implementation Guide) lives in a separate
repository: [FHIR/sql-on-fhir](https://github.com/FHIR/sql-on-fhir).

Browse the existing [implementations page][] or register
[your own](#adding-your-implementation), and try the
[interactive playground][].

[//]: # "Links used in this document."
[implementations page]: https://sql-on-fhir.org/extra/impls.html
[interactive playground]: https://sql-on-fhir.org/extra/playground.html
[ViewDefinition]: https://build.fhir.org/ig/HL7/sql-on-fhir/StructureDefinition-ViewDefinition.html

## FHIR Foundation Project Statement

- Maintainers: TBC at next SQL on FHIR meeting.
- Issues / Discussion:
  [analytics on FHIR@chat.fhir.org](https://chat.fhir.org/#narrow/stream/179219-analytics-on-FHIR).
- License: MIT (TBC at next SQL on FHIR meeting).
- Contribution Policy: [CONTRIBUTING.md](CONTRIBUTING.md) (to be ratified at next
  SQL on FHIR meeting).
- Security Information: Security advisories will be published at the
  [GitHub Security Advisories](https://github.com/FHIR/sql-on-fhir.js/security/advisories)
  page, and you can also
  [report a vulnerability](https://github.com/FHIR/sql-on-fhir.js/security/advisories/new).

## Getting started

The reference implementation and validator use [Bun](https://bun.sh/).

```bash
cd sof-js
bun install
bun test
```

Validate the test suite against the schema:

```bash
bun run validate
```

Build the test report site:

```bash
cd test_report
bun install
bun run prepare
bun run build
```

## Adding your implementation

To have your implementation listed on the [implementations page][], run the
shared test suite against it, publish a test report, and register your
implementation. The steps below describe that process.

### Implement a test runner

The `tests/` directory holds a set of test case files, each a JSON document
covering one aspect of the specification. The format of these files is described
by [`tests.schema.json`](tests.schema.json). In brief, a test case has a
`title`, a `description`, a set of FHIR `resources` used as fixtures, and a
`tests` array. Each entry in that array has a `title`, a [ViewDefinition][] as
its `view`, and the expected result rows in its `expect` attribute.

Your test runner should automate execution of these cases as follows:

- Iterate through each file in the `tests/` directory, treating each as a
  distinct test case.
- Read and parse the file to access its `title`, `description`, `resources` and
  `tests`.
- Load the fixtures (the FHIR resources in the `resources` attribute) into your
  implementation, if required.
- For every test object, evaluate the `view` against the loaded fixtures (for
  example, by calling `evaluate(test.view, testcase.resources)`) and compare the
  result with the rows in the `expect` attribute.

### Generate a test report

The test runner should produce a `test_report.json` file. It is a map keyed by
test file name. Each value is a map with a single `tests` list, and each element
of that list has a `name` and a `result`. The `result` reports whether the named
test `passed`, and may also carry a `reason` describing why a test did not pass.

The following example reports one passing and one skipped test:

```json
{
  "logic.json": {
    "tests": [
      {
        "name": "filtering with 'and'",
        "result": {
          "passed": true
        }
      },
      {
        "name": "filtering with 'or'",
        "result": {
          "passed": false,
          "reason": "skipped"
        }
      }
    ]
  }
}
```

You can validate the structure of your report against
[`test_report/test-report.schema.json`](test_report/test-report.schema.json).

### Publish the test report

Make your `test_report.json` available over HTTP so the implementations page can
fetch it:

1. Choose a hosting service that supports Cross-Origin Resource Sharing (CORS),
   such as a static HTTP server or a cloud storage bucket (AWS S3, Google Cloud
   Storage, Azure Blob Storage).
2. Upload your `test_report.json` to that service.
3. Configure CORS to allow requests from `https://sql-on-fhir.org`, the origin
   that serves the implementations page. For a cloud storage bucket this might
   look like:

   ```json
   [
     {
       "AllowedOrigins": ["https://sql-on-fhir.org"],
       "AllowedMethods": ["GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```

4. Verify that the report can be fetched from a browser without CORS errors.

### Register your implementation

Add an entry to
[`test_report/public/implementations.json`](test_report/public/implementations.json).
This file is a JSON array of objects, each describing an implementation and
pointing at its published test report:

```json
{
  "name": "YourImplName",
  "description": "A short description of your implementation.",
  "url": "https://example.org/your-implementation",
  "testResultsUrl": "https://example.org/test_report.json"
}
```

Ensure `testResultsUrl` points to the latest version of your published report,
then open a pull request with your change. Once merged, your implementation will
appear on the [implementations page][].

## Deployment

> **TODO:** The combined GitHub Actions workflows from the original
> single-repository setup have been relocated here unchanged
> (`.github/workflows/`). They still reference IG build steps and the
> `base_content`/`current_branch` dual-checkout from when the IG and tooling
> lived together. They need to be adapted to this single-repository layout and
> the publishing topology for `sql-on-fhir.org/extra/` resolved before they will
> run correctly. See the IG repository for how the apex domain is currently
> served.
