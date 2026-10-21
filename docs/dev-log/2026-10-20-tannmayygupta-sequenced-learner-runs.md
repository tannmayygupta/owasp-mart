# Sequenced learner runs: one challenge at a time, a countdown each, new runs, account points

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | lab runtime, IF-2 1.3.0, ADR 0063 |

## Requirements covered
C01 to C11, FR-DSH-01, FR-HNT-01, FR-SES-06. Story: `docs/bmad/initiative-lab/backlog/story-sequenced-learner-runs.md`. Decision: `docs/adr/0063-sequenced-learner-runs-with-a-countdown-per-challenge.md`.

## Summary (plain language, 3-5 lines)
A learner's run now goes one challenge at a time. The current challenge has a countdown by difficulty (20, 40 or 60 minutes) that starts when the learner begins it; when its flag is captured or the time is over, it closes and the next one appears. Challenges ahead do not exist for the learner. A finished run can be followed by a new one, and the account keeps the best points per challenge. This fixes the dead end the developer saw on the live lab (an ended run left no Start button).

## Why
The developer's message of 2026-10-20 with a screenshot of the live console (run "reported", no way to start, no challenges shown) and the decisions in the ADR.

## What was built
- `apps/api/src/vulnmart/lab/sequence.py`: tiers and times, the clock ledger, `Sequence` (state of each challenge worked out from stored instants, no timer process) and `SequencedMilestones` (credit and hold count only for the active challenge).
- Runtime: begin, gating of flags and hints, the run rules (sum of times plus 30 minutes) and instance limits, retiring the instance of a finished run, account progress, a tick that submits a finished run. Switched on by `VULNMART_LAB_SEQUENCE=1` (deployed compose file); off by default in code.
- Attempt engine and stores: a finished learner run no longer holds the (user, template) place (`allows_new_run`).
- Postgres: migration 0017 (`challenge_opens`, the partial unique index `uq_attempts_current`), `PgChallengeClockLedger`, purge, newest-attempt lookup.
- API: `beginChallenge`, `getMyProgress`, the enriched and filtered `listChallenges`, 404 for challenges not reached.
- Contract: IF-2 1.3.0 (examples, bundle, generated TypeScript and Python models), table owners 2.2.0, `lab-api.md`, COMPAT and changelog; the fake lab has a sequenced seed attempt and the two operations.

## How it works
For each attempt the order is C01 to C11. A challenge is `solved` (best milestone M3 or a capture held), `expired` (begun and its time passed), or the first of the rest is current (`ready` until begun, then `active`); the rest are `future`. Credit goes through the wrapper, so an event or a pasted flag for any other challenge counts for nothing. A restart loses nothing because only the begin instant is stored.

## Files changed
- Backend: `lab/sequence.py`, `lab/runtime.py`, `lab/api.py`, `lab/stores.py`, `lab/pg.py`, `lab/models.py`, migration `0017_*`, `packages/py-attempts/.../engine.py`, `store.py`.
- Contract and mocks: `contracts/api/lab/*`, `contracts/api/bundle/*`, `contracts/mocks/fake-lab/server.mjs`, `contracts/CHANGELOG.md`, `contracts/COMPAT.md`, `contracts/db/table-owners.yaml`, `packages/ts-client`, `packages/py-models`, `scripts/check_lab_contract.py`.
- Deploy: `infra/deploy/platform.compose.yaml` (`VULNMART_LAB_SEQUENCE`).
- Tests: `test_lab_sequence.py` (14), `test_lab_sequence_api.py` (8), `test_lab_pg.py` (2 new), `scripts/fake-lab.test.mjs` (1 new).

## Decisions made
ADR 0063 (accepted). The rows of COMPAT for IF-2 consumer (Akshay), DB owner (Akshay) and DB consumer (Sahil) are `pending` for the new versions.

## Tests
- `pytest apps/api/tests/test_lab_sequence.py` — 14 passed; `test_lab_sequence_api.py` — 8 passed (answers validated against the contract schemas).
- With a real Postgres 18 (`VULNMART_TEST_POSTGRES_DSN`): `test_kernel_postgres.py` and `test_lab_pg.py` — 33 passed (migration up and down, metadata comparison, the new-run rule, the clock ledger and purge).
- `node --test scripts/fake-lab.test.mjs scripts/platform-mock.test.mjs scripts/ts-client.test.mjs` — 33 and 9 passed.
- `check_lab_contract.py` — 22 operations, 44 valid and 103 invalid examples, PASS; `pnpm run api:check` — OK (123 checks); `pnpm run contracts:rules` — 20 PASS, 0 FAIL.
- Full API suite with Postgres: see the final report of this run.
- Not run: the live lab with `VULNMART_LAB_SEQUENCE=1` (deploy pending).

## Evidence
Command output above.

## Problems met and how they were fixed
- My first design put the held-capture review behind the sequence; a held capture is credited after the challenge already closed, so the wrapper also counts a `solved` challenge.
- The first single-index migration split candidate and learner rules in two indexes and let a learner attempt and a company attempt share a (user, template) pair; one index (`uq_attempts_current`) now covers both.
- The score of an account is per-challenge raw points; the total is rescaled to 1000 like a run's score (a test expected a raw 63).

## Security notes (vulnerable parts only)
The shop still holds every weakness at once; the lab decides what counts. No flag is shown by any new route. `beginChallenge` and `getMyProgress` need the session; begin needs the CSRF token.

## Limitations and follow-ups
- Capacity: a run may hold an instance up to the run limit (8 hours); the idle stop frees an abandoned one (OI-21).
- The old dashboards (`apps/web`) still read `listChallenges`; they work but show fewer challenges for a sequenced run.
