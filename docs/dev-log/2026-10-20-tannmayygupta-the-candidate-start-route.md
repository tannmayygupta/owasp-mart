# The candidate Start route (H-356)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | IF-2 startAttempt, OI-22, D-80, FR-SES-02 |

## Requirements covered
H-356, OI-22 (resolved by D-80), FR-SES-02. Story: `docs/bmad/initiative-lab/backlog/story-the-candidate-start-route.md`. Plan: `docs/plans/2026-10-20-handoffs-h355-to-h359.md`.

## Summary (plain language, 3-5 lines)
A candidate can now press Start. The lab asks for the instance of the attempt that the consent created, and the assessment clock starts when the instance is ready (D-80), so a slow cold start never costs the candidate time. A second press changes nothing; a learner, a finished attempt or a stranger is refused.

## Why
Akshay's privacy-wall story (P-30) found that no candidate could start over HTTP: the route existed in the contract but not in the real API.

## What was built
- `runtime.py`: `_begin` split so the part that asks the orchestrator for an instance (`_prepare`) serves both a new learner run and an existing candidate attempt; new `start_existing_async`.
- `lab/api.py`: route `startAttempt` (owner only, assessment attempt in `ready` or `running`, otherwise 409).
- IF-2 text (operation description, `lab-api.md` rows) now records that OI-22 is resolved; no schema change, so no version step. Bundle and generated clients refreshed.
- `test_lab_contract.py` brought up to date (22 operations, the seeded timeline has the time warning, the mock walk calls `beginChallenge` and `getMyProgress`): these five tests were already failing from stories 6 and 8.

## How it works
The route checks ownership (404 for anyone else), then asks the runtime. The runtime uses the orchestrator template of the lab, keeps the rules the attempt was created with, creates the instance and finishes the same way a learner start does (`_finish`: wait for ready, open access, move to `running`, start the clock).

## Files changed
`apps/api/src/vulnmart/lab/api.py`, `apps/api/src/vulnmart/lab/runtime.py`, `apps/api/tests/test_lab_start_attempt.py`, `apps/api/tests/test_lab_contract.py`, `apps/api/tests/test_privacy_wall.py` (comment), `contracts/api/lab/*`, `contracts/api/bundle/openapi.json`, `packages/ts-client/src/api.d.ts`, records.

## Decisions made
None new: D-80 applies. The answer stays 200 (not 202) as the contract says; the attempt may still read `ready` while the instance starts.

## Tests
- `pytest tests/test_lab_start_attempt.py` — 3 passed (start then running with a deadline, repeat press, learner and finished attempt 409, stranger 404).
- `pytest tests/test_lab_start_attempt.py tests/test_privacy_wall.py tests/test_lab_api.py tests/test_lab_contract.py tests/test_lab_sequence_api.py tests/test_lab_timeline_warnings.py` — first run 222 passed, 5 failed (all in `test_lab_contract.py`, also failing before my change); after fixing the stale counts `test_lab_contract.py` alone: 186 passed.
- `pnpm run contracts:rules` — 20 PASS, 0 FAIL. `pnpm run api:check` — OK.
- Not run: `scripts/check_lab_contract.py` directly (the module `openapi_spec_validator` is missing in the system Python; the same check runs inside `test_lab_contract.py`, which passed). Not run: a real orchestrator start (the tests use the fake instance host).

## Evidence
Command output above.

## Problems met and how they were fixed
- `engine.create` returns the existing attempt for the same person and template, so my first test (a learner and a candidate for the same user) tested the wrong attempt; the test uses a second user for the candidate.

## Security notes (vulnerable parts only)
None. The route is owner-only; a stranger gets 404 as for every other attempt route.

## Limitations and follow-ups
The real orchestrator path of a candidate start is first exercised on the live deploy (story 12).