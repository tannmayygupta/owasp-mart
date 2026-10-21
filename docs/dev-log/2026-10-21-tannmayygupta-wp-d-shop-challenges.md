# Work package D: shop and challenges (C09 event, milestones, decoys, hardening, T-32)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta (with Claude Code) |
| Branch / commit | wp-d-shop-challenges, uncommitted (the lead merges main and commits) |
| Status | Done locally; the run against vm-i (T-32) is the leader's step |
| Report tag | shop, challenges, milestones, T-32 |

## Requirements covered
FR-SHP-01 to FR-SHP-15 (hardening), FR-CHL-* and C01 to C11 (milestones, decoys), FR-FLG-07, D-02, D-72, D-74, OI-17, T-13 (bot stays jsdom, ADR 0061), T-27, T-30, T-32, handoffs H-42, H-43, H-331, audit rows L-21, L-27.

## Summary
The shop now posts `shop.security_event_written` in the C09 pipeline, so the platform's negative-observation rule tells the vulnerable build from the fixed one. Loose milestones (C01 M2, C05 M2, C07 M1, C08 M1 and M2, C10 M1) are tightened and the catalogue text matches the rules. Decoys are in the catalogue and planted by the injector. The shop deferred-work list is implemented with tests. T-32 has a script with a vulnerable and a fixed leg and a runbook.

## Why
The tracker and wiring audits of 2026-10-21 (section 5.3, 5.4; rows L-21, L-27, T-27, T-30, T-32; C09 and decoys in the wiring audit) listed these as gaps.

## What was built
- C09: `recordSecurityEvent` and `recordAuth` in `apps/shop/src/challenges/c09-logging-failures.mjs` emit `shop.security_event_written`; the stale comment is gone; the legacy route of the vulnerable build still skips the pipeline; the fixed build also records `login_locked`.
- Rules: `apps/api/src/vulnmart/ingest/milestone_rules.json` (C01 M2 any of three distinct orders or the target store 2, C05 M2 only `/_ops/diagnostics`, C07 M1 needs `account_found`, C08 M1 names an order, C08 M2 needs `via` webhook, C10 M1 needs `blocked` false); catalogue `signal` text updated (C03 single key, C09 M1).
- Decoys: `decoys` lines in all 11 entries; `apps/shop/src/instance/placements.mjs` and `inject.mjs` plant them (`shop-db`, and `service-file` for C06 and C10); per-instance reseed of seeded passwords (D-02).
- Shop hardening: `web/login-throttle.mjs` (throttle with security events), rehash on login, `BEGIN IMMEDIATE` at checkout, `web/paging.mjs` and a pager partial, `domain/limits.mjs`, `build-id.mjs` and the Dockerfile stamp for `/version`, Assign and Hold buttons.
- T-32: `scripts/verify-deployed-exploits.mjs` (`--build vulnerable|fixed`) and `docs/runbooks/t-32-deployed-verification.md`.
- CI: `exploit-runner` also runs `node scripts/release-gate.mjs`; new job `shop-instance` builds the shop image and runs the instance harness.
- Contract text: IF-4 section 7 milestone mapping (1.0.1) and IF-7 README plus catalogue changelog (1.2.1), documentation and data only. ADR 0072. ADR 0061 notes the jsdom bot stays and how it is configured.

## How it works
The ingest rule for C09 M2 counts `auth.attempt` events on the legacy route with no `shop.security_event_written` for the same account; the shop's `account_id` on the legacy `auth.attempt` is the attacked account (the row found), so the two events can be matched.

## Files changed
See `git status` in the worktree: `apps/shop/src/**`, `apps/shop/test/**`, `apps/api/src/vulnmart/ingest/milestone_rules.json`, `apps/api/tests/test_ingest_*.py`, `challenges/catalog/c*.yaml`, `challenges/tests/c09-*`, `services/mock-services/**`, `scripts/e2e-local-flags.mjs`, `scripts/verify-deployed-exploits.*`, `scripts/validate-catalog.test.mjs`, `contracts/events/app-events.md`, `contracts/catalog/README.md`, `contracts/CHANGELOG.md`, `.github/workflows/ci.yml`, docs.

## Decisions made
ADR 0072 (mapping and decoys in the catalogue). ADR 0061 stays (jsdom).

## Tests
Real runs on 2026-10-21 in the worktree:
- `node --test "apps/shop/test/**/*.test.mjs"`: 203 tests, 200 pass, 3 skipped, 0 fail.
- `node --test "challenges/tests/**/*.test.mjs" "services/**/test/*.test.mjs"`: 147 tests; in one parallel run 1 failed (the sidecar reload test, an unchanged timing-sensitive test, and one bot listener test); each service test file run alone passes (sidecar 31, bot 11, browser 9, import 8, mock-services 9, others all pass) and every challenge test file passes alone.
- `node scripts/release-gate.mjs`: 11/11 on both builds.
- `uv run --offline --package vulnmart-api pytest apps/api/tests/test_ingest_shop_rules.py apps/api/tests/test_ingest_engine.py`: 70 passed.
- `pnpm run contracts:rules`: 22 PASS, 0 FAIL, 1 NOT-APPLICABLE; `pnpm run events:check` PASS; `pnpm run catalog:check` OK; `node scripts/check-text-files.mjs` PASS.
- `node scripts/e2e-local-flags.mjs --docker`: 87 PASS, 0 FAIL (one documented SKIP for C11 M1).
- `node --test scripts/verify-deployed-exploits.test.mjs scripts/e2e-local-flags.test.mjs`: 10 of 10; `scripts/validate-catalog.test.mjs`: 14 of 14 (includes the new no-flag-in-player-text test).
- `node scripts/e2e-local-flags.mjs --build fixed --deployed-script yes`: 10/10 behave as fixed, 3 PASS 0 FAIL; `--build vulnerable --only C01,C02,C04,C05,C07,C08,C09,C10,C11 --deployed-script yes`: 9/9 as vulnerable, 3 PASS 0 FAIL (the T-32 script against a real local shop).
- `docker build` of the shop image then `node apps/shop/instance-harness/shop-instance-check.mjs`: PASS (9 checks).

## Evidence
Command outputs above; no screenshots.

## Problems met and how they were fixed
- `scripts/check-records.mjs` named in the brief does not exist in this tree; not run. The check `scripts/check-text-files.mjs` was run instead.
- An early edit of mine used relative paths with .NET file APIs and wrote two contract files in the main checkout instead of the worktree; the two inserted blocks were removed from the main checkout again (diff empty) and re-applied in the worktree. Backtick escapes in a double-quoted string put control characters in the text; found by `check-text-files`, rewritten.
- The full parallel test run is flaky for two timing tests; not caused by this work.

## Security notes (vulnerable parts only)
No weakness was added or removed: the release gate shows every exploit still holds on the vulnerable build and fails on the fixed one. No flag values appear in docs or tests.

## Limitations and follow-ups
- T-32 against vm-i: the leader or lead runs the commands in `docs/runbooks/t-32-deployed-verification.md` (not run here, no live host touched).
- The CI `shop-instance` job was proven only by running its two commands locally.
- The scripted per-visit bot memory measurement (S-5) is not built.
