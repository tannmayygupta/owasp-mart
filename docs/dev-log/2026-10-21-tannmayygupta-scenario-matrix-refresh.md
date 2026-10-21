# Scenario matrix refresh after packages A to E, and the scenarios no package owned

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta (work package G, second run, by Claude for the leader) |
| Branch / commit | `wp-g2-matrix-refresh`, based on origin/main cd9610e, not committed (the lead commits) |
| Status | Done for the matrix, the code and the tests; the deployed journeys run and the demo rehearsal stay the leader's |
| Report tag | verification |

## Requirements covered
C-30, R-25, A-27, R-20, R-26 and every scenario the first matrix marked MISSING-OWNED-BY A, B, C, E; C-37 and R-30 (blocker recorded); L-30, P-32.

## Summary (plain language)
After packages A to E were merged, every scenario that was missing or partial was tested again on main. 27 more scenarios are VERIFIED (74 to 101 of 145; 36 partial, 5 external, 3 missing: the two write-up scenarios and the admin dashboard of package F), and the seven that no package owned were assigned to a new package H: R-26 turned out to be built already (by B), and C-30/R-25 (extra time), A-27 (admin list of waiting or failing attempts) and R-20 (technique label) were implemented here with tests and contract changes. The write-up scenarios (C-37, R-30) need a table, a contract change and a similarity method and stay open with the exact reason.

## What was built
- Product code: `extendAttempt` (IF-2 2.3.0): `AttemptEngine.extend`, `LabRuntime.extend_attempt`, the route in `lab/api.py`, the `time_extended` event, field `extended_minutes`; `listOpenAttempts` (IF-1 1.9.0): `AdminOps.open_attempts` and the admin route; the report's `technique_label` from the catalogue tags (`technique_label()` in `lab/api.py`).
- Contracts: `lab.openapi.yaml` 2.3.0 (route, `ExtendRequest`, two valid and two invalid examples, md row), `platform.openapi.yaml` (route and two schemas, version row 1.9.0), fake-lab mock, `check_lab_contract.py`, COMPAT and CHANGELOG, bundle and generated code regenerated; ADR 0096.
- Tests: `apps/api/tests/test_scenarios_refresh.py` (22 tests), `packages/py-attempts/tests/test_engine_extend.py` (5 tests, plus parametrised), the lab-contract and privacy-wall tests extended for the new operations, `test_scenario_matrix.py` accepts web test references and package H.
- Documents: the matrix and the role-scenarios marks regenerated from a table kept with the author (counts below), the ASVS rows that the merged packages closed (V13.4.2, V14.2.7, V2.3.2 are now met; V6.3.7 re-assigned).

## How it works
The refresh tests use the combined world of the first run plus: the admin quota port on the lab, mail triggers wired to the attempt log, an eraser on the deletion service, the email-change settings on the self service, and a `mirror()` of the lab attempt and instance into the SQL tables that the deletion, retention and admin code read (the in-memory lab store of the test world does not fill them).
Extra time: the engine adds minutes to the stored deadline of a `running` attempt whose deadline has not passed, keeps the total (240 at most) and lets a warning that is due again fire again; the runtime refuses an extension that would pass the fixed lifetime of the instance (5 minutes short). The report label is the catalogue title and primary CWE.

## Files changed
New: `test_scenarios_refresh.py`, `test_engine_extend.py`, four contract examples, ADR 0096, this dev-log, the story and its plan. Edited: the files listed under "What was built", `test_privacy_wall.py` (two operations), `test_lab_contract.py` (25 operations), `docs/audit/2026-10-21-scenario-matrix.md`, `docs/audit/2026-10-21-role-scenarios.md`, `docs/security/asvs-checklist.md`, `docs/traceability.md`, `CHANGELOG.md`, `contracts/CHANGELOG.md`, `contracts/COMPAT.md`.

## Decisions made
ADR 0096. The IF-1 owner row of COMPAT for 1.9.0 is left `pending` like B's 1.8.0 row (the leader closes it); the IF-2 rows are `approved` for the leader as before.

## Tests
Run in `C:\Users\tanma\vulnmart-wp-g2` on 2026-10-21:
- `pytest` of the six scenario files, the matrix test, `test_privacy_wall.py`, `test_lab_contract.py`, `test_admin_api.py`, `test_admin_ops.py`, `test_wp_b_routes.py`, `test_invite_lifecycle.py`, `test_lab_quota.py` in `apps/api`: **435 passed, 1 xfailed** (202 s). The xfail is the first run's finding (duplicate milestone log line), still failing on main.
- `pytest packages/py-attempts/tests`: 381 passed.
- `node --test scripts/check-asvs.test.mjs scripts/e2e-live-journeys.test.mjs`: 13 pass; `node --test` of fake-lab, platform-mock, ts-client, ci-workflow-shape, validate-contracts: 70 pass; `apps/web` unit tests: 35 pass.
- `pnpm run contracts:rules`: 22 PASS, 0 FAIL, 1 NOT-APPLICABLE; `pnpm run contracts:check`: all four contract checks PASS; `pnpm run api:check`: bundle current (107 operations), generated code current, 133 model checks ok, ts-client and web typecheck ok.
- `node scripts/check-records.mjs`: PASS; `node scripts/check-text-files.mjs`: PASS; `node scripts/check-asvs.mjs`: ok, 345 requirements (met 176, partly 51, not met 13, n.a. 105); `node scripts/check-deployed-compose.mjs`: PASS (scheduler on, real mail by default, dashboards routed).
- Not run: a browser run of the dashboards, Postgres-only tests, a live send of real mail, `scripts/live-ops-check.mjs`, the journeys on the deployed site.
- Seen, not mine: `node --test scripts/check-deployed-compose.test.mjs` has one failing test on this Windows checkout (`fails when: no http redirect`, 15 of 16 pass).
Traceability: the rows of the section "Verification: scenario matrix, ASVS and live journeys".

## Evidence
The matrix and the checklist are the documents.

## Problems met and how they were fixed
- A first enum named `problem` in the new IF-1 schema collided with the generated `Problem` model (`api:check` failed); renamed to `issue`.
- A here-string swallowed backticks in the OpenAPI description and a trailing newline joined two YAML blocks; the bundle refused them, both fixed.
- A failed start destroys its instance and leaves the attempt `ready`, so the admin list cannot call it `failing`; it is shown as `waiting` and documented; the `failing` case is a running attempt whose instance the orchestrator reports as failed.
- The retention test first did nothing: the mirrored attempt row had no submit time, so the job used the real clock instead of the test clock; the mirror now carries it.
- The first guess for the email-change test returned 500: the world's self service had no keys or settings; wired in the fixture.
- `R` is an alias of `Invoke-History` in PowerShell (a helper with that name did nothing); edits that need exact text were done with the Edit tool.

## Security notes (vulnerable parts only)
None. The admin list shows ids, states and instants only; no flag, address or result.

## Limitations and follow-ups
- C-37 and R-30 (write-ups and their similarity review) are assigned to package H with this blocker: they need a new table (DB contract change, migration, table owner), erasure with the attempt, export, an IF-1 route for the candidate and one for the recruiter, and a similarity method that the PRD does not define. D-99 already settles optional by default.
- Reopening an ended attempt is not built and should not be (the instance and its keys are gone, FR-SES-06).
- Four admin settings are still read nowhere (`instance_idle_minutes`, `instance_max_minutes`, `hints_enabled_default`, `flag_submit_per_minute`).
- Deleting a company leaves its running attempts running.
- ADR number 0096 and the story id 22 were taken without a check against package F's worktree; rename if they collide.