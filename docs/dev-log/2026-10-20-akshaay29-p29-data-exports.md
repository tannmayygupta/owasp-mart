# Data exports

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p29` |
| Status | Done (story `done`, confirmed by the developer 2026-10-20) |
| Report tag | platform, exports, sprint 4 |

## Requirements covered
FR-EXP-01, FR-EXP-02, FR-EXP-03, FR-EXP-04, FR-PRV-11 (the company export in the view history), OI-27 (answered by the developer 2026-10-20). Story 3 of `epic-dashboards-and-exports` (ref 8.3, task P-29).

## Summary (plain language, 3-5 lines)
A candidate or learner can download all their own data from the account page as a zip of JSON and CSV files: profile, consents, attempts with results, timings, hints and the requests that captured flags, who viewed their data and their deletion requests. A recruiter can download one assessment's results from the company page: per candidate the score and details as CSV and JSON, without evidence. Every export is recorded in the audit log, a company's export also appears in each candidate's "who viewed my data", and no flag value is ever in an export.

## Why
Nobody could export data and no export was audited. Task P-29 of `docs/dev/dev2-akshay.md`.

## What was built
- `privacy/exports.py` (`ExportService`: `own_zip`, `company_zip`, flag redaction, CSV formula guard), `privacy/export_api.py` (`exportMyData` `POST /api/v1/me/exports`, `exportCompanyResults` `POST /api/v1/company/exports`, IF-1 1.5.0), the setting `rate_export_per_user_per_hour` (10, a placeholder), the wiring in `main.py`.
- Web: `download()` in `lib/api.ts`; "Download my data" on the account page; "Export results" per template on the company page.

## How it works
Both routes are POST with the CSRF header because they write: an audit entry (`export.own`, `export.company`) and, for the company export, an `exported` entry in each candidate's view history. The zip is built in memory on the server: the platform's data from its own services, the lab's results read (read only) from the lab runtime of the same process. Captured requests pass through `redact` (anything shaped like `VM{...}` becomes `VM{redacted}`); the export never reads the flag material. CSV cells starting like a formula get a leading quote. The browser receives `application/zip` with `Content-Disposition: attachment` and saves it.

## Files changed
- New: `apps/api/src/vulnmart/privacy/{exports,export_api}.py`, `apps/api/tests/test_exports.py`, `apps/api/tests/test_exports_company.py`, one valid and one invalid request example, `docs/adr/0060-*.md`, the story plan, `docs/assets/p-29-data-exports/`.
- Changed: `ports/settings.py`, `main.py`, `platform.openapi.yaml`, the bundle, the generated models and types, `contracts/CHANGELOG.md`, pins in `test_platform_contract.py` and `test_role_gates.py`, `scripts/e2e/platform-stack.e2e.test.mjs`, `apps/web/lib/api.ts`, `apps/web/app/account/page.tsx`, `apps/web/app/company/page.tsx`, `apps/web/test/dashboard-lib.test.mjs`, `docs/dev/HANDOFFS.md` (H-145), `docs/adr/README.md`, `docs/traceability.md`, `docs/dev/dev2-akshay.md`, `CHANGELOG.md`, `docs/progress/index.html`.

## Decisions made
By the developer (2026-10-20): OI-27, a recruiter exports scores as CSV and JSON, no evidence ("Scores, CSV + JSON"); continue in the same manner. By the builder, in ADR 0060 (Proposed): the zips built on the server so every export is one audited request, the lab runtime read in process, flag-shaped text redacted, a per-account rate limit.

## Tests
On the developer's Windows 11 PC, Docker 28.5.1, throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-29-data-exports/`.
- `test_exports.py` 6 and `test_exports_company.py` 3: 9 passed (redaction; the CSV formula guard; a learner who captured a flag on the real lab runtime exports through the route: nine files, the attempt's results, no flag value anywhere, audit `export.own`; another person's export holds only their data; session, CSRF and rate limit; no lab in the process; the company export: CSV and JSON of scores, no evidence, audit `export.company`, view history `exported`; another company refused; the route only for recruiters).
- Pins changed on purpose: IF-1 operations 58 to 60 and two new state-changing paths; with the settings and admin tests 136 passed.
- Contract: `check_platform_contract.py` OK (60 operations); `check_api_models.py` OK (120 checks); `platform-mock.test.mjs` 20 of 20; contract rules **18 PASS, 0 FAIL**, 1 not applicable (`contract-rules-2026-10-20.txt`).
- Full `pytest apps/api/tests`: **2822 passed, 0 failed, 1 skipped** in 503 s (`pytest-full-2026-10-20.txt`; the skip is the Windows file-mode check).
- `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"`: 1210 tests, 1202 pass, **3 fail on this PC**: the three generator tests (`datamodel-codegen` is not installed here; CI has it) (`script-and-app-tests-2026-10-20.txt`).
- Web: `tsc --noEmit` clean; web tests 17 of 17 (the new `download` error-path test).
- Stack end to end on real Docker (images rebuilt, build exit 0): start-up, the P-26, P-27 and new P-29 tests and tear-down **6 of 6** on the first run (`stack-e2e-2026-10-20.txt`): a learner's export needs the CSRF header (403 without), answers `application/zip` with the attachment name and the nine files, and adds one `export.own` row to `audit_log`; a recruiter signs up, is approved, accepts the terms, makes a template and exports it: three files, one `export.company` row; a learner asking for the company export gets 404.
- NOT run: a browser (the download buttons were not clicked); an export with real lab results on the Compose stack (it has no lab in the API process; the real-lab case is `test_exports.py`); CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-29-data-exports/`: the full pytest output, the script and app tests, the contract rules, the image build log, the stack run.

## Problems met and how they were fixed
- The first company-export test built the services by hand with the wrong signatures and clashed with the lab fixtures in the same file; moved to `test_exports_company.py` over the existing company fixtures.
- The tests first read `FakeAuditPort.entries`; the attribute is `records`.
- `check_platform_contract.py` wanted an example for the zip answers; a placeholder string (the schema is `string`, `binary`).
- My first draft of the service reached into the assessment service's private `_companies`; the company service is now passed in.

## Security notes (vulnerable parts only)
None: platform code. Hardening: flag-shaped text redacted, CSV formula injection guarded, POST with CSRF so a cross-site page cannot trigger an export, per-account rate limit, another company's template is "not found".

## Limitations and follow-ups
- The export reads the lab runtime of the API process; a split deployment would need a lab port (ADR 0060).
- The company export covers the 100 newest invites of a template (the list limit).
- The rate limit (10 an hour) is a placeholder.
- Not browser-tested (OI-30).
