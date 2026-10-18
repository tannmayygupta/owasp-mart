# Attempt engine: start at instance ready, expiry, freeze, destroy, submit, cancel (story 7.2)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (commit of this story follows; not committed when this entry was written) |
| Status | Partly done: engine library built and tested locally with a fake clock, store and instance control; no API adapter, no database store, no live run |
| Report tag | attempt engine, expiry, auto-submit, freeze, FR-SES-02, FR-SES-04 to FR-SES-08, D-83, D-84, D-88 |

## Requirements covered
FR-SES-02, FR-SES-04, FR-SES-05, FR-SES-06, FR-SES-07, FR-SES-08, FR-TIM-05 (library part); decisions D-83, D-84, D-88 (new, Proposed); ADR 0041; handoff H-328 (new). Task L-22 (second of its stories; stays unticked).

## Summary (plain language, 3-5 lines)
The engine runs an attempt: it starts the clock when the instance is ready, sends the time warnings, expires an overdue attempt and submits it at the deadline, freezes the instance for 15 minutes and then destroys it. It also does manual submit, cancel and "report". A repeated or concurrent tick does nothing twice. It only talks to small interfaces (a store and an instance control), so it is tested without Docker or a database.

## Why
FR-SES-02, 04, 05, 06, 07 need something that runs an attempt, and the platform needs `AttemptPort` from stream L and a job its scheduler can call. Rules were built in story 7.1.

## What was built
- `packages/py-attempts/src/vulnmart_attempts/store.py`, `instances.py`, `engine.py` (new): `AttemptRecord`, `AttemptStore` Protocol with an in-memory store, `InstanceControl` Protocol (`freeze`, `destroy`, idempotent), `AttemptEngine(store, instances, clock, events=None)` with `create`, `get`, `instance_ready`, `submit`, `cancel`, `mark_reported`, `tick`.
- Events as small dicts (ids, state names, UTC times): `attempt.state_changed`, `time_warning_sent`, `session_expired`, `session_submitted`, `instance_destroyed`.
- Tests: `test_engine.py`, `test_engine_expiry.py`, `test_engine_concurrency.py`, helper `conftest_engine.py`.
- Not built (deviation, decided by the developer's session): the `apps/api` adapter `EngineAttemptPort`, the dependency and Dockerfile lines, `EngineReportPort`, the runbook `docs/runbooks/attempt-expiry-live-check.md` and the `apps/api` verification commands. They move to the later integration step.

## How it works
`tick()` finds due attempts and, in order: sends due warnings, expires (`running` to `expired` to `submitted`, `submitted_at` = deadline), freezes access, and destroys once `frozen_until` (submitted plus 15 minutes) has passed. If the scheduler was down, freeze and destroy happen in the same tick. Every write is a compare-and-set on a version; a lost race raises `Conflict` and the caller retries. Destroy uses a 60 s claim so two engines make exactly one destroy call; a failed freeze or destroy leaves the record unchanged for the next tick. `mark_reported` only moves `submitted` to `reported` when scoring exists and no held capture is open.

## Files changed
- `packages/py-attempts/src/vulnmart_attempts/{store,instances,engine}.py`, `__init__.py` (exports) - new / changed
- `packages/py-attempts/tests/{conftest_engine,test_engine,test_engine_expiry,test_engine_concurrency}.py` - new
- `docs/assets/story-7-2-attempt-engine/test-output.txt` - raw output
- Docs: this entry, ADR 0041, `initial.md` (D-83, D-84, D-88), HANDOFFS, CHANGELOG, traceability, dev1 file

## Decisions made
D-83 (expiry sequence and freeze), D-84 (engine is the only writer, idempotent, compare-and-set, tick every 15 s as a placeholder), D-88 (`reported` only through `mark_reported`). See `docs/adr/0041-attempt-clock-scoring-and-expiry.md`. Choices inside the plan to confirm: one attempt per `(user_id, template_id)` (the plan text said per invite and consent, the developer's instruction was per user and template); the destroy claim lease; freeze must succeed before destroy; no warnings after the deadline; a failing event sink never undoes a stored step.

## Tests
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests`: 254 passed in 0.61 s (221 before, 33 new). Raw output in the evidence file.
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: pass (plan notes).
- NOT run: `uv lock --check`, `check-contract-rules`, `uv run --package vulnmart-api pytest`, `docker build` (apps/api was not touched).
Traceability rows: FR-SES-02, 04 to 08, FR-TIM-05.

## Evidence
`docs/assets/story-7-2-attempt-engine/test-output.txt`.

## Problems met and how they were fixed
- The package test forbids the token `threading`, so the in-memory store uses `_thread.allocate_lock` instead.
- The plan wanted API edits (dependency, adapter); the developer's session forbade `apps/api` edits for this run, so the adapter spec is written into H-328 instead.

## Security notes (vulnerable parts only)
Not a vulnerable part. Event dicts hold ids, state names and UTC times only (no names, emails or bodies). A lost connection is not an input anywhere, so a candidate cannot stop the clock.

## Limitations and follow-ups
- Not proved live: the real `attempts` table store, the scheduler calling `tick()` every 15 s, the gate refusing shop requests while access is `frozen`, the orchestrator destroying the real instance after 15 minutes. All need the platform and a developer runbook run.
- `EngineAttemptPort`, the SQL store, scheduler wiring and the `apps/api` state-name comparison test remain (H-328, Akshay's side and the integration step).
- Held-capture review (OI-38) has no owner yet; `mark_reported` takes `held_open` from the caller.
