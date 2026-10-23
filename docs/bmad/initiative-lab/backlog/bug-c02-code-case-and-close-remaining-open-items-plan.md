---
title: "C02 redeem code rejected on case, plus FR-ACH-01 hard cap, settings wiring and an admin route for a silently escalated deletion request"
ticket: 64
status: in-review
assignee: "tannmayygupta"
---

## Progress
- 2026-10-23: C02 case-sensitivity fix, FR-ACH-01 hard cap, `instance_idle_minutes`/`instance_max_minutes`/`flag_submit_per_minute` wiring and A-19 (admin escalated-deletion route) implemented and tested; `hints_enabled_default` deliberately deferred (see ADR 0097). Real commands and results: `node --test apps/shop/test/c02-gift-card-codes.test.mjs` 4/4 pass (2/4 proven to fail without the fix); `node --test apps/shop/challenges/tests/c02-gift-card-codes/c02.test.mjs` 2/2, no regression; `uv run --package vulnmart-api pytest apps/api/tests/test_deletion.py test_deletion_api.py test_deletion_postgres.py test_admin_ops.py test_admin_api.py test_admin_postgres.py test_lab_pg.py test_lab_runtime.py test_flags_submit.py -q` with `VULNMART_TEST_POSTGRES_DSN`/`VULNMART_TEST_APP_DSN` set — 242 passed, 0 skipped. Live reproduction of the C02 bug and the exploit path on the deployed instance (pre-fix). Pushed as branch `fix-c02-case-and-close-gaps`, PR #97.
- 2026-10-23 (CI fix): PR #97's CI failed on `api tests`/`script tests` — the two new admin routes were never added to the IF-1 OpenAPI contract, `test_role_gates.py`'s admin-route allowlist was not updated, and two scenario-matrix rows used a status word ("DONE") outside the allowed vocabulary. Fixed: IF-1 bumped 1.9.0 to 1.10.0 (additive, `contracts/CHANGELOG.md` and `contracts/COMPAT.md` updated, re-approved under D-104), bundle and generated code regenerated, both test files corrected. `pnpm run contracts:check`/`contracts:rules`/`api:check` all clean; `pytest test_role_gates.py test_scenario_matrix.py test_spec_routes_check.py` 19 passed. State: in-review, pushed, waiting on CI to go green before merge.
