# SQL on FHIR.js

This repository holds the JavaScript reference implementation, the shared JSON
conformance test suite, and the test report site for the SQL on FHIR v2.0
specification. The constitution below records the non-negotiable principles that
govern how this project is specified, planned, built and reviewed.

## Constitution

### Core Principles

#### I. Specification fidelity (NON-NEGOTIABLE)

The SQL on FHIR specification is the source of truth
(https://build.fhir.org/ig/HL7/sql-on-fhir/llms.txt). The reference
implementation MUST conform to the published specification, and the shared test
suite MUST encode behaviour the specification defines. Where the implementation
and the specification disagree, the specification wins and the implementation
is the defect. Behaviour that the specification does not define MUST NOT be
relied upon by tests, and any intentional extension beyond the specification
MUST be documented as such.

Rationale: this repository exists to demonstrate and validate the specification.
Drifting from it silently would mislead every downstream implementer who treats
this project as the reference.

#### II. Language-neutral conformance tests

The contents of `tests/` are a cross-implementation conformance artifact, not
fixtures for the JavaScript engine. Each test case MUST be declarative JSON that
is valid against `tests.schema.json`, MUST express expectations purely in terms
of `ViewDefinition` inputs and expected result rows, and MUST NOT assume any
language, runtime, library or storage technology. No JavaScript-specific
behaviour may leak into a test case.

Rationale: implementers in any language run this suite. A test that only makes
sense to `sof-js` is not a conformance test.

#### III. Test-first (NON-NEGOTIABLE)

Test-driven development is mandatory. For any feature or fix, the test that
defines the expected behaviour MUST be written first, MUST be observed to fail
for the right reason, and only then may implementation code be written to make
it pass. A change that adds or alters behaviour without an accompanying test
that would have failed beforehand MUST NOT be merged.

Rationale: a reference implementation earns trust through demonstrable coverage,
not assertion. Tests written after the fact tend to encode what the code does
rather than what the specification requires.

#### IV. Stable public contracts

`tests.schema.json`, `test_report/test-report.schema.json`, the test case file
format, and the test report format are public contracts that external
implementations depend on. Backwards-incompatible changes to any of them MUST
NOT be made silently. A breaking change MUST be justified, called out
explicitly in review, and accompanied by a version signal so that consumers can
detect it. Prefer additive, backwards-compatible evolution.

Rationale: other projects parse these formats and publish reports against them.
An unannounced breaking change breaks their tooling without warning.

#### V. Verified green before merge

Every change MUST pass the full shared verification pipeline before it is
merged: the test suite (`bun test`), schema validation of the test cases
(`bun run validate`), and the formatting check (`bun run check-fmt`). A failing
or skipped check MUST NOT be worked around by disabling, excluding or weakening
the check; if a check is wrong, the check is fixed openly. The state of these
checks is the project's signal of correctness and MUST be kept honest.

Rationale: green checks are the only evidence other implementers have that the
reference behaves as claimed. Suppressing a check converts a known problem into a
hidden one.

### Additional constraints

- The reference implementation, validator and test report tooling are run with
  Bun, as documented in the project README.
- New or substantially changed test cases MUST be added to the shared `tests/`
  suite rather than kept local to the implementation, so that every
  implementation is measured against them.
- The specification itself lives in a separate repository
  (`FHIR/sql-on-fhir`); this repository MUST NOT attempt to redefine
  specification semantics, only to implement and test them.

### Governance

This constitution sits above ad hoc preference: where other guidance conflicts
with a principle here, the principle prevails. Amendments are made by editing
this section directly, with the rationale for the change recorded in the
commit. A reviewer SHOULD be able to point at a pull request and name the
principle it violates; principles that cannot be violated by a concrete change
do not belong here and SHOULD be removed.
