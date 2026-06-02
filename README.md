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

## Deployment

> **TODO:** The combined GitHub Actions workflows from the original
> single-repository setup have been relocated here unchanged
> (`.github/workflows/`). They still reference IG build steps and the
> `base_content`/`current_branch` dual-checkout from when the IG and tooling
> lived together. They need to be adapted to this single-repository layout and
> the publishing topology for `sql-on-fhir.org/extra/` resolved before they will
> run correctly. See the IG repository for how the apex domain is currently
> served.
