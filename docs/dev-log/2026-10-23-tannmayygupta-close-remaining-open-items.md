# Fix the C02 "redeem card doesn't exist" bug and close the remaining open-items list (FR-ACH-01, settings wiring, A-19)

| Field | Value |
|---|---|
| Date | 2026-10-23 |
| Developer | tannmayygupta |
| Branch / commit | fix-c02-case-and-close-gaps |
| Status | Partly done (see Limitations) |
| Report tag | (free text for now; the college report template is pending) |

## Requirements covered
FR-CHL-03 (C02), FR-ACH-01, A-10, L-11, A-19, FR-PRV-08, D-104

## Summary (plain language, 3-5 lines)
A tester reported C02 (Cryptographic Failures) as unsolvable: the real bug was that a correctly-forged redeem code in uppercase hex was rejected as "malformed code," which looks identical to "the exploit doesn't work" to a confused learner — fixed by normalising the code before validation. Separately, the leader asked for every item on a prior "open and not yet implemented" list to be worked through end to end: implemented and fully tested (including real Postgres) the FR-ACH-01 30-per-assessment hard cap, wired three of the four dead admin settings (`instance_idle_minutes`, `instance_max_minutes`, `flag_submit_per_minute`), and gave an admin a route to decide a candidate's deletion request the company never answered (A-19). `hints_enabled_default` is deliberately deferred with its reasoning recorded (too wide a blast radius to risk in this change); several items from the list (A20, A21, L19, accessibility, CI additions, C37/R30, OI-33, C30/X19, screenshot-ban) are not started — see Limitations.

## Why
The leader's literal instruction: "Implement every open, incomplete, unused, and unverified item listed above end to end... never claim completion without evidence... if anything is genuinely blocked... clearly document the exact blocker." This dev-log covers the tractable items actually finished in this pass.

## What was built
1. **C02 fix** — `redeem()` in `apps/shop/src/challenges/c02-gift-card-codes.mjs` now normalises a submitted code (`normalize(raw)`: case-insensitive match on `/^vm-([0-9a-f]{12,})$/i`, canonicalised to lowercase `VM-<hex>`) before validating and looking it up, instead of comparing the raw string against a lowercase-only pattern.
2. **FR-ACH-01 hard cap** — `FlagSubmitService` in `apps/api/src/vulnmart/flags/submit.py` refuses the 31st wrong paste for a (attempt, challenge) pair for the rest of the assessment (`MAX_INCORRECT_PER_ASSESSMENT = 30`), counted by the real `PgFlagSubmissionLog.incorrect_total` when available (new method in `apps/api/src/vulnmart/lab/pg.py`) or an in-memory fallback otherwise, reusing the existing `FlagRateLimited`/`ATT-FLAG-RATE-LIMITED` error with a 24-hour `retry_after` (`CAP_RETRY_AFTER_S`).
3. **Settings wiring** — `LabRuntime` (`apps/api/src/vulnmart/lab/runtime.py`) gained a `settings: SettingsPort | None` and reads `instance_idle_minutes`/`instance_max_minutes` fresh for every new instance (`_base_limits`) and `flag_submit_per_minute` fresh for every new learner attempt (`_rules_for`), with the candidate/sequenced floors still applied on top; `build_lab_runtime` now wires a real `DbSettingsPort` over the lab's own engine in production. `admin/ops.py::RANGES` gained the missing `flag_submit_per_minute` bound (1-60, matching `Rules.flag_submissions_per_minute`'s own validation) so an out-of-range admin value is refused at the settings API instead of crashing the next learner's attempt start.
4. **A-19** — `DeletionService.escalated()`/`decide_escalated()` (`apps/api/src/vulnmart/privacy/deletion.py`) let an admin see and decide (approve/decline) a candidate deletion request whose company missed `deletion_decide_days`, matched by request id alone since an admin crosses every company; `AdminOps.escalated_deletions`/`decide_escalated_deletion` (`admin/ops.py`) gate it to an admin and audit the read and the decision; new routes `GET /api/v1/admin/deletion-requests/escalated` and `POST /api/v1/admin/deletion-requests/{request_id}/decision` (`admin/api.py`).

## How it works
See ADR 0097 for the design reasoning on each item (why reuse `FlagRateLimited` instead of a new error code, why settings are read live instead of baked in at boot, why `hints_enabled_default` is deferred, why A-19 mirrors the company's own `decide`).

## Files changed
- `apps/shop/src/challenges/c02-gift-card-codes.mjs` — case-insensitive code normalisation
- `apps/shop/test/c02-gift-card-codes.test.mjs` (new) — regression tests, proven to fail without the fix
- `apps/api/src/vulnmart/flags/submit.py` — FR-ACH-01 hard cap
- `apps/api/src/vulnmart/lab/pg.py` — `PgFlagSubmissionLog.incorrect_total`
- `apps/api/src/vulnmart/lab/runtime.py` — `_base_limits`, `_rules_for` read live settings; `build_lab_runtime` wires `DbSettingsPort`
- `apps/api/src/vulnmart/admin/ops.py` — `flag_submit_per_minute` range; `escalated_deletions`/`decide_escalated_deletion`
- `apps/api/src/vulnmart/admin/api.py` — two new routes and their request/response bodies
- `apps/api/src/vulnmart/privacy/deletion.py` — `EscalatedDeletion`, `escalated`, `decide_escalated`
- `apps/api/tests/test_flags_submit.py`, `test_lab_pg.py`, `test_lab_runtime.py`, `test_deletion.py`, `test_deletion_postgres.py`, `test_admin_ops.py`, `test_admin_api.py` — new tests for all of the above

## Decisions made
ADR 0097 (`docs/adr/0097-settings-wiring-hard-cap-and-admin-escalated-deletion.md`): FR-ACH-01 error-code reuse, live-vs-baked-in settings reads, the `hints_enabled_default` deferral, and the A-19 admin route design, each with alternatives considered.

## Tests
Real commands and real output, all run locally on this machine, `fix-c02-case-and-close-gaps` branch:

```
cd apps/shop && node --test test/c02-gift-card-codes.test.mjs
# 4 pass (with the fix); confirmed 2 of 4 fail with the fix stashed out (regression proven)
cd apps/shop && node --test challenges/tests/c02-gift-card-codes/c02.test.mjs
# 2 pass, no regression

$env:VULNMART_TEST_POSTGRES_DSN = "postgresql://vulnmart:ci-owner-throwaway@localhost:55434/vulnmart"
$env:VULNMART_TEST_APP_DSN = "postgresql://vulnmart_app:ci-app-throwaway@localhost:55434/vulnmart"
uv run --package vulnmart-api pytest apps/api/tests/test_deletion.py apps/api/tests/test_deletion_api.py \
  apps/api/tests/test_deletion_postgres.py apps/api/tests/test_admin_ops.py apps/api/tests/test_admin_api.py \
  apps/api/tests/test_admin_postgres.py apps/api/tests/test_lab_pg.py apps/api/tests/test_lab_runtime.py \
  apps/api/tests/test_flags_submit.py -q
# 242 passed, 0 skipped (2026-10-23, throwaway Postgres 18 container vm-wp-pg on port 55434)
```

Live reproduction of the C02 bug and the fix path against the deployed instance (`tanmay-platform-prod.duckdns.org`), using the audit account `player.customer@vulnmart.test`: a forged lowercase code for serial 1 (`VM-c4ca4238a0b9`) redeemed the flag correctly; the identical code in uppercase (`VM-C4CA4238A0B9`) was rejected with `{"error":"malformed code"}` (400), confirming the bug before the fix. The fix itself (code normalisation) has not yet been redeployed live — see Limitations.

## Evidence
No flag values or secrets recorded (documentation rule). Postgres test output and shop test output are the commands above; no screenshots taken this session (service/API-level work, not browser-visible).

## Problems met and how they were fixed
- The throwaway Postgres container (`vm-wp-pg`) from an earlier session chunk was still running but its credentials were not in this shell's environment (PowerShell tool state does not persist `$env:` variables between calls); found the owner password from `docker inspect vm-wp-pg`'s `POSTGRES_PASSWORD` and reused the app-role password from the earlier session's record (`ci-app-throwaway`); real Postgres tests then ran with 0 skips.
- First draft of `test_escalated_requests_are_listed_oldest_first_across_every_company` called `active_company()` a second time, which unconditionally re-inserts the fixed test admin user and collided (`UNIQUE constraint failed: users.id, users.account_type`); fixed with a `second_company()` helper that skips the duplicate `add_admin` call.
- First draft of the timing in that same test put both companies' requests past their deadline in a single `run()` call, so both got the identical `escalated_at` and the assertion on list order depended on an arbitrary id tiebreak; fixed by calling `service.run()` twice at two different times so the two requests escalate at genuinely different instants.
- First assertion on `decide_escalated`'s `execute_after` assumed the 7-day hold counted from the escalation time; it actually counts from `self._now()` (the real decision time), which in the test fixture never advances just because `rig.run(14)` was called with a future `now` argument — fixed the assertion, not the code (the code's behaviour — the hold starts from the decision, not from the escalation — is correct and is what the company's own `decide` already does).

## Security notes (vulnerable parts only)
C02 remains deliberately vulnerable by design (CWE-328, unsalted MD5-derived codes); the fix only removed an incidental case-sensitivity bug in the vulnerable build's own validation, not the planted weakness itself. The fixed build (random codes + keyed hash) is unaffected by this change.

## Post-push CI fixes (same task, 2026-10-23)
PR #97's CI (`api tests`, `script tests`) failed on three self-inflicted gaps found only by CI, not by the targeted local runs above: (1) the two new admin routes were served but never added to the IF-1 OpenAPI contract (`scripts/check_spec_routes.py` / `test_spec_routes_check.py`); (2) `test_role_gates.py` asserts the exact set of admin state-changing routes and needed the new one added; (3) `test_scenario_matrix.py` enforces a fixed status-word vocabulary that does not include "DONE" (my own invention) — changed the A-19 and L-11 rows to `VERIFIED`, which is both the correct word and accurate (each already names a passing test). Fixed by: adding `listEscalatedDeletions`/`decideEscalatedDeletion` and their schemas to `contracts/api/platform/platform.openapi.yaml` (IF-1 1.9.0 → 1.10.0, additive, no breaking change), regenerating the bundle and generated code (`node scripts/bundle-openapi.mjs`, `node scripts/generate-api-code.mjs`), updating `contracts/CHANGELOG.md` and `contracts/COMPAT.md` (IF-1 row re-approved under D-104), and the two test-file fixes above. Verified: `pnpm run contracts:check` and `pnpm run contracts:rules` both clean (19 PASS, 0 FAIL), `uv run --package vulnmart-api python scripts/check_spec_routes.py` PASS (108 routes, 109 operations), `pnpm run api:check` clean (bundle current, generated code current, 133 model checks, ts-client typecheck clean, 36 web unit tests pass), `pytest apps/api/tests/test_role_gates.py test_scenario_matrix.py test_spec_routes_check.py` 19 passed.

## Post-push CI fix #2 (same task, 2026-10-23)
After the contract fix above, CI's `script tests` still failed: `scripts/platform-mock.test.mjs` sends every POST operation's valid request-body example (by schema name, from `contracts/api/platform/examples/valid/`) generically; `EscalatedDeletionDecisionRequest` had no example file, so the mock test sent no body/no Content-Type and got 415 instead of 200. Fixed by adding `examples/valid/admin-escalated-deletion-decision.json` and `examples/invalid/admin-escalated-deletion-decision-wrong-type.json`, matching the pattern of the other admin decision schemas, and correcting the IF-1 1.10.0 changelog's mock-change line (the mock server code itself needed no change, only example data). Verified: `pnpm run contracts:check`/`contracts:rules` clean; `node --test scripts/platform-mock.test.mjs` 20/20 passed.

## Limitations and follow-ups
- Not committed, pushed, PR'd, merged or deployed yet as of this dev-log; that is the next step once the documentation rule is satisfied.
- `hints_enabled_default` is deliberately not wired (see ADR 0097); next action: audit every `AttemptRecord`/`Rules` construction path in the test suite, then change `_rules_for` and `hints_enabled`.
- Not started in this pass (from the leader's longer list): A-20 (mail retry list for admins), A-21 (live backup/restore re-verification), L-19 (idle-destroy live proof), accessibility audit (L-25/C-36/X-19), CI additions for the browser suites, a second off-host backup location, audit-anchor automation, candidate integrity signals (tab-blur/fullscreen-exit/copy-restriction — researched and approved in principle in an earlier session, not implemented). Blocked-by-product-decision items are unchanged: C-37/R-30 (write-up similarity algorithm choice), OI-33 (age/guardian consent, needs a legal decision), C-30/X-19 (accommodation policy, needs a product decision); L-15 (sequential-start) is working as designed, not a bug; a literal "screenshot ban" was already researched and found technically infeasible on the web in an earlier session (vdocipher.com, a W3C mailing-list thread, Xobin proctoring docs) and copy-restriction/integrity-flag alternatives were proposed instead.
- The C02 fix has not yet been redeployed to the live lab; the live reproduction above used the pre-fix code to confirm the bug, not the post-fix build.
