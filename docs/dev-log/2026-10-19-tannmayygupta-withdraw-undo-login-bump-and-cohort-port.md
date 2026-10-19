# Withdraw and undo routes, the login bump (FR-SES-11) and the cohort port, live

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | tannmayygupta |
| Branch / commit | l-withdraw-undo-and-login-bump |
| Status | Done for L-05, L-18, L-26; partly done for L-28 (port only); L-11 and L-30 unchanged (reasons below) |
| Report tag | lab, IF-2 1.1.0, FR-SES-09, 10, 11, FR-SCR-07, 08 |

## Requirements covered
L-05, L-18, L-26, L-28, L-30 (numbers only), L-11 (re-checked); FR-SES-09, FR-SES-10, FR-SES-11, FR-SCR-07, FR-SCR-08; D-91, D-93; handoffs H-341, H-346, H-353.

## Summary
The tasks that waited on stream P are closed as far as stream L can close them without stream P's routes. Withdraw and undo are real HTTP routes now (IF-2 1.1.0), a new login raises the access epoch so the gate ends the older browser tab, and the private cohort board has its platform adapter. All three were proved on the deployed system, except the cohort port (no route exists to call it).

## Why
The earlier audit left L-26 (no route), L-18 (platform half of FR-SES-11 missing) and L-28 (no adapter) open and marked them as waiting for Akshay. They did not need his routes to be built on the lab side, so they were built here against mocks of nothing: the real runtime, real Postgres and the real gate.

## What was built
- IF-2 1.1.0: `withdrawAttempt` (`POST /api/v1/attempts/{id}/withdraw`, body `{"confirm": true}`), `undoWithdrawal` (`POST .../withdraw/undo`), optional `Attempt.delete_after`. Candidate attempts only, owner only; a learner attempt or a wrong state is 409 ATT-INVALID-STATE, a closed window is 410 ATT-GONE; no new error code. Mock, examples, bundle, generated clients and `check_lab_contract.py` (20 operations) updated.
- `LabRuntime.undo_withdrawal`, `LabRuntime.bump_access_for_user` (ready and open instances only, retried by `tick` after a host failure), `SessionService.set_login_hook` (called after the login session is committed, never fails the login), `_login_bump` in `main.py` (own thread so a slow orchestrator never delays a login).
- `EngineCohortPort` (`ports/engine_cohort.py`) and `LabRuntime.cohort`: one company, one assessment, `submitted` or `reported` attempts only, aid order, refusal before any row is read.
- `scripts/e2e-live.mjs`: the journey now signs in a second time and checks that the older tab is refused at the gate and the new login works (34 checks). New `scripts/e2e-live-withdraw.mjs` (11 checks).

## How it works
Login bump: `open_session` -> hook -> thread -> for each ready or running attempt of the account with an open instance, `set_access(OPEN, epoch + 1)` through IF-5. The gate compares the epoch inside the ticket and cookie with the epoch pushed to it, so the older tab's cookie is refused and the new login's ticket carries the new epoch. The platform's older sessions are not ended (the user's session list and "log out everywhere" belong to P-12).
Withdraw: the route checks the owner and that the attempt is a candidate attempt, then calls the engine (destroys the instance, sets `delete_after` after the undo window, nothing scores afterwards). Undo clears `delete_after`; the attempt stays `withdrawn` (D-91).

## Files changed
- `contracts/api/lab/lab.openapi.yaml`, `lab-api.md`, `examples/valid/*`, `contracts/mocks/fake-lab/server.mjs`, `contracts/api/bundle/*`, `packages/ts-client/src/api.d.ts`, `packages/py-models/src/vulnmart_models/api.py`, `contracts/CHANGELOG.md`, `contracts/COMPAT.md`
- `apps/api/src/vulnmart/lab/{api,runtime}.py`, `accounts/sessions.py`, `main.py`, `ports/engine_cohort.py`
- tests: `apps/api/tests/{test_lab_api,test_lab_contract,test_login_bump,test_engine_cohort,test_contract}.py`, `scripts/fake-lab.test.mjs`
- `scripts/e2e-live.mjs`, `scripts/e2e-live-withdraw.mjs`, `scripts/check_lab_contract.py`
- docs: `docs/dev/dev1-tanmay.md`, `docs/dev/HANDOFFS.md` (H-353, H-341 answered), `docs/traceability.md`, `CHANGELOG.md`

## Decisions made
The withdraw and undo routes are in IF-2 (the lab owns the state machine and the undo window), not IF-1 as `lab-api.md` once said; cancel and purge stay with the platform. This is a proposal for Akshay to confirm (H-353). No ADR: it is a placement of two routes, written in the contracts changelog. The login bump does not end the older platform sessions (H-341 asked for both); the reason is in H-353 for Akshay to decide.

## Tests
- `apps/api` full run before the last two fixes: 2406 passed, 227 skipped (Postgres tests, no database here), 1 failed (`test_contract.py::test_the_ports_package_holds_only_the_three_modules`, fixed by naming the new module); after the fixes `test_lab_contract.py` 186 passed and `test_contract.py` 62 passed. The Postgres tests run in CI.
- `node --test scripts/*.test.mjs`: 892 tests, 890 passed, 0 failed, 2 skipped.
- `node scripts/check-contract-rules.mjs --base origin/main`: 18 PASS, 0 FAIL; `pnpm run contracts:check` and `pnpm run api:check` pass.
- Deployed: `e2e-run14-login-bump.json` 34 PASS, 0 FAIL (older tab 403 after the second login); `e2e-run15-withdraw.json` 11 PASS, 0 FAIL; `e2e-run16-load8.json`: 5 of 8 instances ready, 3 clean 429 (capacity).

## Evidence
`docs/assets/production-readiness/e2e-run14-login-bump.json`, `e2e-run15-withdraw.json`, `e2e-run16-load8.json`.

## Problems met and how they were fixed
- The mock and contract tests pinned 18 operations: updated to 20 and the two calls added.
- A second candidate attempt for the same user and template returns the first (one per user and template): the second test uses another user.
- Docker on vm-p needs sudo (`sudo docker exec`); the plain `ssh` of the shell uses another key, the project scripts use the Windows OpenSSH client.
- The load check left five instances running on vm-i. Cleaning them with a cancel of the attempts was refused by the permission system (cancelling attempts on the live platform), so they free themselves by the idle and duration limits; until then the demo site may answer 429 when more than two people start an instance at once.

## Security notes
No flag value appears anywhere. The withdraw route answers 404 for another account and for a deleted attempt, the same as a missing one. The login hook never fails a login and runs on its own thread.

## Limitations and follow-ups
- The candidate attempt of the live withdraw proof was made through the lab runtime of the API container; the invite and consent routes of stream P do not exist.
- L-28 needs Akshay's IF-1 route and recruiter screen. L-30 needs the assessment journey and Sahil's T-32. L-11: the demo site is no longer behind the origin secret; `createLiveTicket` should be removed (H-353).
- Not proved live: the timed idle destroy, C06 and C10 against the real import and mock services, a forced certificate renewal on vm-i.