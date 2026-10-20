---
title: 'Data exports'
type: 'feature'
ticket: '3'
created: '2026-10-20'
status: in-progress
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/prd/PRD.md'
  - '{project-root}/docs/adr/0059-recruiter-routes-and-the-recruiter-dashboard.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** Nobody can export data: a candidate and a learner cannot take their own data with them (FR-EXP-01, 02), a recruiter cannot export an assessment's results (FR-EXP-03), and no export is audited (FR-EXP-04).

**Approach:** An `ExportService` that builds zips of JSON and CSV on the server, so every export is audited: `exportMyData` (`POST /api/v1/me/exports`: profile, consent history, every attempt of the caller with results, timings, hints and evidence requests, who viewed their data, deletion requests) and `exportCompanyResults` (`POST /api/v1/company/exports` for one template: per candidate the states, the score, the times, the hints used, the open integrity flags and the points per challenge; no evidence). The lab's results are read from this process's lab runtime (read only). Buttons on the account page and the company page download them.

## Boundaries & Constraints

**Decisions (developer):** 2026-10-20 "continue with the other tasks of sprint 4 in same manner"; OI-27 answered 2026-10-20: a recruiter exports scores as CSV and JSON, no evidence.

**Always:** no other person's data in a person's export; no flag value anywhere (anything shaped like a flag is redacted; the export never reads the flag material); every export audited; the company export recorded in each candidate's view history; CSV cells guarded against spreadsheet formulas.

**Never:** no PDF; no evidence in the company export; no new error code; no change to IF-2.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Own export | any signed-in person | zip with nine files; audit `export.own` | no session 401; no CSRF 403; too many 429 |
| No lab in the process | own export | zip, attempts empty with a note | n/a |
| Company export | recruiter, own template | zip with results.csv and results.json; audit `export.company`; view history `exported` per candidate | another company's template 404; not a recruiter 404 |
| Flag in evidence | captured request with `VM{...}` | `VM{redacted}` | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/privacy/{exports,export_api}.py`, `ports/settings.py` (`rate_export_per_user_per_hour`), `main.py`; IF-1, bundle, generated code, examples; tests `test_exports.py`, `test_exports_company.py`.
- Web: the account page and the company page get the download buttons.

## Tasks & Acceptance

**Execution:**
- [x] The service, the routes, the contract change and their tests (2026-10-20: 9 export tests, contract rules 18 PASS).
- [ ] The download buttons; the stack test.

**Acceptance Criteria:**
- Given a learner who captured a flag, then their export holds the attempt's results and no flag value, and an audit entry is written.
- Given a recruiter, then the export of their template holds each candidate's scores and no evidence, and each candidate's view history says "exported".
- Given another company, then the template cannot be exported.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `pytest apps/api/tests` with the Postgres and Valkey addresses set -- expected: pass
- web tests, `tsc --noEmit`, `next build` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (the P-29 test) -- expected: pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
