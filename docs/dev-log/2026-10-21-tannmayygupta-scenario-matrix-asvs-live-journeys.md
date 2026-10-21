# Scenario matrix with evidence, ASVS requirement by requirement, and the live role journeys

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta (work package G, run by Claude for the leader) |
| Branch / commit | `wp-g-scenarios-asvs-e2e`, based on origin/main db3721b, not committed (the lead commits) |
| Status | Partly done: matrix, ASVS table and scripts are done and tested locally; the run on the deployed site and the demo rehearsal are the leader's steps and have not happened |
| Report tag | verification, security |

## Requirements covered
L-30, L-31, P-32, NFR-SEC-01, NFR-SEC-02, D-102; tracker audit 2026-10-21 items 8 and 9; every scenario id of `docs/audit/2026-10-21-role-scenarios.md` (L-01 to X-21).

## Summary (plain language)
All 145 role scenarios were exercised through the real routes and now have a status backed by a named passing test, or an owner when the behaviour is missing. The ASVS table is requirement by requirement (345 rows) with a script that checks it. A new script walks the hiring journey (recruiter, candidate, admin) against a deployed site; it ran against the local test server, not yet against the deployed site.

## Why
The tracker audit found no invite, assessment or recruiter report in the end-to-end suite (L-30), no rehearsal (L-31), and an ASVS table at chapter level only (P-32).

## What was built
- `apps/api/tests/scenario_support.py`: the combined world of the privacy-wall tests plus two admins with a proved second factor, the real admin operations, break-glass, the second-factor service and the production password policy, with helpers (invite a person, accept and consent, start, mail outbox).
- `test_scenarios_learner.py` (21 tests), `_candidate.py` (30), `_recruiter.py` (19), `_admin.py` (15), `_cross.py` (9 passed, 1 xfail), `test_scenario_matrix.py` (4): every test name starts with the scenario id.
- `docs/audit/2026-10-21-scenario-matrix.md` (generated from a table kept with the author, checked by `test_scenario_matrix.py`) and a `(matrix: ...)` mark on every row of the role-scenarios audit.
- `docs/security/asvs-checklist.md`, `scripts/check-asvs.mjs`, `scripts/check-asvs.test.mjs`, a CI step in the `scripts` job, a `registry change:` line in `contracts/CHANGELOG.md`.
- `scripts/e2e-live-journeys.mjs` and its test, `docs/runbooks/live-e2e-journeys.md`, `docs/runbooks/demo-rehearsal.md`.

## How it works
The scenario tests call the routes the dashboards call, as each role, over SQLite with the real lab runtime on the fake instance host (the privacy-wall world). They assert behaviour that is correct on main today, so they keep passing when packages A to F merge. The matrix test fails when a row names a missing test or a VERIFIED row has none.
The ASVS rows come from the official list (`OWASP/ASVS` tag `v5.0.0`, `5.0/docs_en` CSV, 345 requirements: 70 level 1, 183 level 2, 92 level 3, downloaded 2026-10-21 into a scratch folder and read with a parser). Each row's evidence names files or tests; the check script verifies that they exist.
The live script reads credentials from `VM_E2E_*` environment variables, takes the mail from Mailpit over ssh (live) or from the seeded local server (local), and prints PASS, FAIL or SKIP without secrets; `--dry-run` validates and prints the plan only.

## Files changed
- New: the six test files and `scenario_support.py` under `apps/api/tests/`, `scripts/check-asvs.mjs` and test, `scripts/e2e-live-journeys.mjs` and test, `docs/audit/2026-10-21-scenario-matrix.md`, `docs/security/asvs-checklist.md`, two runbooks, this dev-log, the story and its plan.
- Edited: `docs/audit/2026-10-21-role-scenarios.md` (status marks and a pointer), `docs/traceability.md`, `CHANGELOG.md`, `contracts/CHANGELOG.md`, `.github/workflows/ci.yml` (one step). No product code was changed.

## Decisions made
No new technical decision, no ADR. Choices inside the task: ASVS version 5.0.0 as already cited (PRD NFR-SEC-01); level 2 for the platform and level 3 for admin, orchestrator and key service as in D-21; thread tests call the lab runtime because the test database is one shared SQLite connection.

## Tests
Run in `C:\Users\tanma\vulnmart-wp-g` on 2026-10-21:
- `uv run --offline --package vulnmart-api pytest tests/test_scenarios_learner.py tests/test_scenarios_candidate.py tests/test_scenarios_recruiter.py tests/test_scenarios_admin.py tests/test_scenarios_cross.py tests/test_scenario_matrix.py` in `apps/api`: **98 passed, 1 xfailed** in 127 s.
- `node --test scripts/e2e-live-journeys.test.mjs scripts/check-asvs.test.mjs`: **13 pass, 0 fail**.
- `node scripts/check-asvs.mjs`: ASVS checklist ok: 345 requirements (met 173, partly 54, not met 13, n.a. 105).
- `node scripts/check-records.mjs`: records: PASS (0 warning(s)).
- `pnpm run contracts:rules`: 16 PASS, 0 FAIL, 1 NOT-APPLICABLE (approvals needs the CI reviews file).
- `node scripts/check-text-files.mjs`: PASS (after removing a BOM that `Set-Content -Encoding utf8` of Windows PowerShell 5.1 had written into two files).
- Local run of the journeys: the API of `apps/api/tests/e2e_web_server.py` on port 18080, then `node scripts/e2e-live-journeys.mjs --local-e2e http://127.0.0.1:18080 --skip-admin`: **15 PASS, 0 FAIL, 4 SKIP** (company state, view history, invite list and export are not mounted on that server).
- Not run: the journeys on a deployed site, the admin steps against a real admin with an authenticator (covered only by the fake platform and the RFC 6238 test vector), the Postgres races (they skip without a database), the demo rehearsal.
Traceability rows: L-30, L-31, P-32 and the 145-scenario row in the section "Verification: scenario matrix, ASVS and live journeys".

## Evidence
Outputs are in this file; the matrix and the ASVS table are the documents themselves.

## Problems met and how they were fixed
- First assumptions were wrong in many scenarios and the tests showed the real behaviour: the template's time limit and results timing already reach the attempt on main (the audit's LB-4 is fixed for these); an unverified account is refused at sign-in (403), not at accept; an invite in state `created` cannot be revoked, only cancelled; suspending a company does not end its recruiters' sessions; a session ends after 30 idle minutes, so tests that move the clock sign in again.
- Concurrency over HTTP failed with `sqlite3.InterfaceError` because the test world shares one SQLite connection between threads. Dropped HTTP-level thread tests for invites; the thread tests call the lab runtime instead; invite races are proved on Postgres by existing tests.
- The thread test found a real defect: five identical correct pastes at once each write a `milestone_reached` line (score correct). Recorded as an xfail test and a finding in the matrix.
- The deletion request and force-stop read the SQL attempt table, which the in-memory lab store does not fill; the force-stop test mirrors the row, C-25 cites the existing `test_deletion_api.py`.
- PowerShell: `R` is an alias of `Invoke-History`, so a helper named `R` did nothing (nothing was written by that call; the edits were redone with the Edit tool). `Set-Content -Encoding utf8` writes a BOM in Windows PowerShell 5.1.
- ASVS data came from a download of the official CSV (WebFetch only summarises); it is parsed as data and not executed.

## Security notes (vulnerable parts only)
None: no vulnerable part was changed. No flag value, password or secret was written to a document; the scripts print none.

## Limitations and follow-ups
- The ASVS table is a code and test review by the author, not an independent audit; 54 rows are partly met and 13 not met, each with an owner. Rows resting on the deployed edge need `scripts/verify-deployed.mjs` re-run after the redeploy.
- The scenario matrix records 23 scenarios as missing and owned by a package (B 13, A 7, C 1, E 1, F 1) and 7 without an owner (C-30, C-37, R-20, R-25, R-26, R-30, A-27): the leader decides who builds them.
- The package that touches flags should fix the duplicate journal line (xfail test `test_xc2b_...` passes silently once fixed).
- The leader runs `docs/runbooks/live-e2e-journeys.md` after the deploy and fills `docs/runbooks/demo-rehearsal.md` after each rehearsal; L-30 and L-31 stay open until then.
