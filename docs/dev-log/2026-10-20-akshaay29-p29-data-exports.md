# Data exports

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p29` |
| Status | In progress (service and routes done; the buttons next) |
| Report tag | platform, exports, sprint 4 |

## Requirements covered
FR-EXP-01, FR-EXP-02, FR-EXP-03, FR-EXP-04, FR-PRV-11 (the company export in the view history), OI-27 (answered by the developer 2026-10-20). Story 3 of `epic-dashboards-and-exports` (ref 8.3, task P-29).

## Summary (plain language, 3-5 lines)
(Filled at the end of the story.)

## Why
Nobody could export data, and no export was audited. Task P-29 of `docs/dev/dev2-akshay.md`.

## What was built
- `privacy/exports.py` (`ExportService`), `privacy/export_api.py` (`exportMyData`, `exportCompanyResults`, IF-1 1.5.0), the setting `rate_export_per_user_per_hour`.

## How it works
(Filled at the end of the story.)

## Files changed
(Filled at the end of the story.)

## Decisions made
By the developer (2026-10-20): OI-27, a recruiter exports scores as CSV and JSON, no evidence ("Scores, CSV + JSON"). By the builder, in ADR 0060 (Proposed).

## Tests
- `test_exports.py` 6 and `test_exports_company.py` 3: 9 passed (redaction, the CSV formula guard, a learner who captured a flag on the real lab runtime exports through the route: nine files, the results, no flag value, audit `export.own`; another person's export holds only their own data; session, CSRF and rate limit; no lab; the company export: CSV and JSON of scores, no evidence, audit `export.company`, view history `exported`; another company refused; the route only for recruiters).
- Pins changed on purpose: IF-1 operations 58 to 60 and two new state-changing paths; with the settings and admin tests 136 passed.
- `check_platform_contract.py` OK (60 operations); `check_api_models.py` OK (120 checks); `platform-mock.test.mjs` 20 of 20; contract rules 18 PASS, 0 FAIL.

## Evidence
`docs/assets/p-29-data-exports/`.

## Problems met and how they were fixed
- The first company-export test built the services by hand with the wrong signatures and clashed with the lab fixtures; moved to its own file over the existing company fixtures.
- The tests first read `FakeAuditPort.entries`; the attribute is `records`.
- `check_platform_contract.py` wanted an example for the zip answers; a placeholder string (the schema is `string`, `binary`).

## Security notes (vulnerable parts only)
None: platform code.

## Limitations and follow-ups
(Filled at the end of the story.)
