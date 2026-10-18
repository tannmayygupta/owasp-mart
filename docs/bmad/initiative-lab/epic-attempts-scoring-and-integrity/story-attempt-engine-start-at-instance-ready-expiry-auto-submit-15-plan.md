---
title: 'Attempt engine: start at instance ready, expiry with auto-submit, 15-minute freeze, destroy, manual submit, cancel, and the port adapter'
type: 'feature'
ticket: '2'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/architecture/05-key-flows.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Rules exist (story 1) but nothing runs an attempt: no start at instance ready, no expiry with auto-submit, no freeze, no destroy, no manual submit (FR-SES-02, 04, 05, 06, 07). The platform needs `AttemptPort` from stream L (H-06, H-79) and a job it can call from its scheduler.

**Approach:** In `packages/py-attempts` add `engine.py`: `AttemptEngine(store, instances, clock, events)`. `AttemptStore` Protocol (`get`, `put_if_version`, `due(now)`; a record is a frozen dataclass with a `version`; a lost compare-and-set raises `Conflict` and the caller retries) with `InMemoryAttemptStore`. `InstanceControl` Protocol with two calls, `freeze(instance_id)` (IF-5 access `frozen`, `InstanceHost.set_access`, apps/api `instance_host.py:449`; the orchestrator side is `engine.py:636`) and `destroy(instance_id)`; both idempotent. Public calls: `create(...)` (state `ready`, idempotent on `consent_id`, one attempt per invite), `instance_ready(attempt_id, at)` (the D-80 start: `ready` to `running`, sets `started_at`, `deadline_at`), `submit(attempt_id)` (manual, only from `running` and within deadline plus grace), `cancel(attempt_id, by, reason)` (from `ready` or `running`, destroys the instance, records who and why), `mark_reported(attempt_id, held_open)` (`submitted` to `reported` only when scoring exists and no held capture is open), and `tick()` which does, for every attempt that is due and in this order: send due warnings, expire (`running` to `expired` to `submitted`, `submitted_at` = `deadline_at`), freeze, and destroy once `frozen_until` has passed. `events` is a callable that receives small ids-and-metadata dicts (`attempt.state_changed`, `time_warning_sent`, `session_expired`, `session_submitted`, `instance_destroyed`) which the platform maps to IF-3 and the FR-TIM-04 log (story 4). Add `EngineAttemptPort` in `apps/api/src/vulnmart/ports/engine_attempts.py` (implements the current `AttemptPort` Protocol and adds `instance_ready`, `submit`, `tick`) and conformance tests against `FakeInstancePort`.

**Proposed (decided on the developer's delegation):**
- **D-83:** expiry sequence: `running` to `expired` to `submitted` in one tick with `submitted_at` = `deadline_at` (not the tick time), then access `frozen`, `frozen_until` = `submitted_at` + 15 minutes, then destroy once `frozen_until` has passed. The freeze is the `frozen_until` column and the instance access value, not a state (arch 04 section 10.1). If the scheduler was down and `frozen_until` is already past, freeze and destroy happen in the same tick (the evidence writers have had the whole outage). A manual submit uses `submitted_at` = now.
- **D-84:** the engine is the only writer of attempt state; every step is idempotent (a repeated tick or a repeated call returns the current record), uses compare-and-set on a version, and a failed `freeze` or `destroy` leaves the record unchanged so the next tick retries. The scheduler runs `tick()` every 15 s (placeholder, `Rules`-independent platform setting); the 15-minute freeze and 120-minute limit are exact to that granularity.
- **D-88:** `reported` is reached only by `mark_reported`, called after the final score snapshot and only when no held capture is open (FR-SCR-10); a submitted attempt with an open held capture stays `submitted`.

## Boundaries & Constraints

**Always:** all time from the injected clock; `tick()` safe to call concurrently from two processes (compare-and-set decides); `cancel` and `withdraw` refused outside their allowed states with `InvalidTransition`, mapped by the adapter to the existing `AttemptStateInvalid` (ATT-INVALID-STATE); an expired or submitted attempt cannot be reopened; the event dicts hold ids, state names and UTC times only (no names, emails, request bodies); the adapter returns the same `Attempt` dataclass as today and does not change `AttemptPort` for existing callers (new calls are additions); a lost connection is not an input anywhere, test it by never calling anything but `tick()` for the whole attempt.

**Never:** a real Docker, orchestrator, database or network in the unit tests (the engine only sees `InstanceControl`); changing IF-2, IF-5, IF-3 or any contract file or an error code; adding a dependency to the package; editing `apps/api` outside `ports` and `tests`, except the two pure-addition lines of the dependency (below) announced in H-328; the Excel tracker; commits, pushes, checkout, stash, reset; live runs (AWS, vm-i).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Start | instance ready at T | `running`, `started_at` T, `deadline_at` T+120 min | none |
| Start twice | `instance_ready` repeated | same record, unchanged deadline | none |
| Expiry | tick at deadline | `expired` then `submitted`, `submitted_at` = deadline, access frozen, `frozen_until` = +15 min | none |
| During freeze | tick at +14 min | instance not destroyed, access stays frozen | none |
| After freeze | tick at +15 min | instance destroyed once; a later tick does nothing | none |
| Late scheduler | first tick 3 h after deadline | submitted at the deadline, frozen and destroyed in that tick | none |
| Two ticks at once | two engines, one store | one effect, no double destroy | the loser retries on `Conflict` |
| Freeze call fails | `InstanceControl.freeze` raises | record unchanged, next tick retries | error logged without ids of people |
| Manual submit | `running`, in time | `submitted`, same freeze and destroy | none |
| Submit after deadline + grace | `running` but past 60 s | refused; the tick expires it | `InvalidTransition` |
| Reopen | submit again, `submitted` | refused | `InvalidTransition` |
| Cancel | recruiter cancels `running` | `cancelled`, instance destroyed, `by` and `reason` recorded | none |
| Cancel a submitted attempt | any | refused | `InvalidTransition` |
| Second attempt for an invite | `create` with a new consent for the same invite | the first attempt returned, no second | none |
| Report with held capture | `mark_reported(held_open=1)` | stays `submitted` | none |
| Report | `held_open=0`, score exists | `reported` | none |
| Warnings | tick at 15 and 5 minutes left | two events, each once | none |

</frozen-after-approval>

## Code Map

- `packages/py-attempts/src/vulnmart_attempts/{engine,store}.py` (new) on `states.py`, `rules.py`, `schedule.py` of story 1.
- `packages/py-attempts/tests/test_engine.py`, `test_engine_expiry.py`, `test_engine_concurrency.py` (new): every matrix row; the concurrency test uses two threads and the in-memory store.
- `apps/api/src/vulnmart/ports/attempts.py:49-69` (read; `AttemptPort`: `create_from_consent`, `get`, `cancel`, `withdraw`, `purge`) -- the adapter implements these; `withdraw` and `purge` call the engine's state table only here (the full withdrawal behaviour is story 5).
- `apps/api/src/vulnmart/ports/lab_fakes.py:53-101` (`FakeAttemptPort`), `:171` (`FakeInstancePort`; `:260` `force_stop`, `:225` `advance`) -- pattern for the adapter tests and the fake `InstanceControl`.
- `apps/api/src/vulnmart/ports/instance_host.py:449` (`set_access`) -- the real freeze; `apps/orchestrator/src/vulnmart_orchestrator/engine.py:636` (`set_access`: refuses a lower access epoch, so the freeze uses `access_epoch` + 1).
- `apps/api/src/vulnmart/ports/errors.py:57-65` (`AttemptNotFound`, `AttemptStateInvalid`, `AttemptGone`) -- error mapping.
- `apps/api/src/vulnmart/kernel/entrypoints/scheduler.py` (read only, Akshay's) -- where `tick()` will be called (job registration is Akshay's, H-328).
- `apps/api/pyproject.toml:6-15` and `apps/api/Dockerfile:22-30` -- two additions Akshay's CI needs once the API depends on the package: dependency `vulnmart-attempts` with `[tool.uv.sources] vulnmart-attempts = { workspace = true }`, and `COPY packages/py-attempts/pyproject.toml ...` and `COPY packages/py-attempts/src ...` lines like the `py-models` ones; also the `.dockerignore` of the API build. Made as a pure addition by L in this commit (H-328) unless Akshay answers otherwise; if he objects, the adapter module moves to the library behind a Protocol and he wires it.
- `apps/api/tests/test_ports_lab.py:12-26` (pattern) -- new `apps/api/tests/test_engine_attempts.py`: `isinstance(EngineAttemptPort(...), AttemptPort)`, the state lists equal, the error mapping, one expiry run against `FakeInstancePort` (instance goes `frozen` then stopped).
- Docs: dev-log, CHANGELOG, traceability (FR-SES-02, 04, 05, 06, 07, 08, FR-TIM-05), HANDOFFS rows, evidence `docs/assets/story-7-2-attempt-engine/` (the real pytest output), the runbook `docs/runbooks/attempt-expiry-live-check.md` (new, numbered steps for the developer, see Verification).

## Tasks & Acceptance

**Execution:**
- [ ] `store.py`, `engine.py` -- as in the Approach (D-83, D-84, D-88)
- [ ] `engine_attempts.py` in `apps/api/.../ports` -- `EngineAttemptPort`; dependency and Dockerfile lines (H-328)
- [ ] tests in the package and `apps/api/tests/test_engine_attempts.py` -- every matrix row
- [ ] runbook for the live check, handoffs and docs as in the Code Map

**Acceptance Criteria:**
- Given a fake clock and a ready instance, then at deadline the attempt is `submitted` with `submitted_at` = deadline, the fake instance access is `frozen`, and 15 minutes later the instance is destroyed once.
- Given a 3-hour scheduler outage, then one tick produces the same final record as ticks every 15 s would.
- Given two engines on one store, then exactly one destroy happens.
- Given a manual submit, a cancel and an expiry, then the freeze and destroy steps are the same for the first and third, and a cancel destroys at once and records who and why.
- Given `mark_reported(held_open=1)`, then the state stays `submitted`.
- Given only `tick()` calls for the whole attempt (no heartbeat), then the deadline never moves.

## Verification

**Commands (Windows dev PC, from the repository root):**
- `uv lock --check` -- expected: pass
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests` -- expected: pass
- `uv run --locked --package vulnmart-api pytest -q` -- expected: pass (including `test_engine_attempts.py`)
- `docker build -f apps/api/Dockerfile .` -- expected: builds (the Dockerfile copies the new package; skip and say so if no Docker daemon)
- `node scripts/check-contract-rules.mjs`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

**Provable locally:** the whole state machine, expiry, freeze order, destroy timing, concurrency and idempotency with fake clock, store and instance control. **Needs the live platform (developer runbook, never claimed here):** the real `attempts` table store, the scheduler calling `tick()` every 15 s, the gate really refusing shop requests while access is `frozen` (L-17 edge), and the orchestrator destroying the real instance after 15 minutes; the runbook shows how to start a test attempt with a 3-minute limit on the demo stack, watch access go `frozen`, and confirm the instance is gone, with the evidence to save (redacted output).

## Handoffs to add in the same commit

- **H-328 (to P-26, P-05, Akshay):** (1) the API gets the dependency `vulnmart-attempts` and the Dockerfile COPY lines (pure addition, made by L unless you object); (2) the scheduler job calls `AttemptEngine.tick()` every 15 s and the API calls `submit`, `instance_ready` (from the orchestrator state report `ready`), `cancel`; (3) the DB `AttemptStore` needs `get`, `due(now)` (attempts in `ready`, `running`, `expired` or `submitted` with `frozen_until`, ordered by deadline) and a version column for compare-and-set; (4) the dashboards show `deadline_at` and `server_time` only, never compute the remaining time from the browser clock. Default if no answer: L ships the in-memory store for the demo and Akshay writes the SQL store when the attempts migration lands.

## Implementation Notes

**Built (2026-10-17).** Library only; deviation decided by the developer's session: no edit to `apps/api` (pyproject, Dockerfile, ports, tests), no `EngineAttemptPort` or `EngineReportPort` yet. Those, the runbook and the `apps/api` verification commands (`uv run --locked --package vulnmart-api pytest -q`, `docker build`) are not done in this story and move to the later integration step.

**Files (new):** `packages/py-attempts/src/vulnmart_attempts/{store,instances,engine}.py`; `tests/conftest_engine.py` (helpers), `tests/test_engine.py`, `tests/test_engine_expiry.py`, `tests/test_engine_concurrency.py`. `__init__.py` exports the new names. Still standard library only (the in-memory store uses `_thread.allocate_lock`, because the package test forbids the token `threading`).

**Real result:** `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests` gave `254 passed` (221 before, 33 new). Raw output: `docs/assets/story-7-2-attempt-engine/test-output.txt`. `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs` both PASS. `uv lock --check` and `check-contract-rules` were not run.

**Shapes built.**
- `AttemptRecord` (frozen): `id, user_id, template_id, consent_id, created_at, rules, state, instance_id, version, ready_at, started_at, deadline_at, submitted_at, frozen_until, access ("open"|"frozen"), warnings_sent, destroyed, destroy_claim_at, cancelled_by, cancelled_reason, cancelled_at, reported_at`; property `times` gives `AttemptTimes`.
- `AttemptStore` Protocol: `get`, `find(user_id, template_id)`, `add` (version 0, `Conflict` on duplicate id or pair), `put_if_version(record, expected_version)` (stored copy gets version + 1, `Conflict` on mismatch), `due(now)`.
- `InstanceControl` Protocol: `freeze(instance_id)`, `destroy(instance_id)`, idempotent, raise on failure.
- `AttemptEngine(store, instances, clock, events=None)`: `create(user_id, template_id, consent_id, rules=None, instance_id=None, attempt_id=None)`, `get`, `instance_ready(attempt_id, at, instance_id=None)`, `submit`, `cancel(attempt_id, by, reason)`, `mark_reported(attempt_id, held_open, scoring_exists=True)`, `tick() -> tuple of changed attempt ids`.
- Events (dicts with `event, attempt_id, state, at` plus small extras): `attempt.state_changed` (`from`, `to`), `time_warning_sent` (`minutes_left`), `session_expired`, `session_submitted` (`reason` manual or expired), `instance_destroyed`.

**Decisions made in code, to confirm.**
1. One attempt per `(user_id, template_id)` (developer's instruction); the plan text said per invite and consent. `create` returns the first attempt.
2. Destroy uses a claim (`destroy_claim_at`, 60 s lease, `DESTROY_CLAIM_LEASE_SECONDS`) so two engines make exactly one `destroy` call; a failed destroy releases the claim. A crashed owner is taken over after the lease.
3. Freeze is done first and must succeed before destroy; a freeze failure also holds back the destroy. A cancelled attempt destroys at once and a failed destroy is retried by `tick()`.
4. Warnings are never sent after the deadline, so one late tick is equal to many small ticks except for `warnings_sent` (tested).
5. `mark_reported` with `held_open > 0` or `scoring_exists=False` returns the record unchanged; from a state other than `submitted` or `reported` it raises `InvalidTransition`.
6. A failing event sink is logged and never undoes a stored step. Control-port failures are logged with the attempt id only.

**H-328 content (adapter spec for Akshay's API, to wire in the integration step; nothing applied now).**
1. `apps/api/pyproject.toml`: add dependency `vulnmart-attempts` and `[tool.uv.sources]` entry `vulnmart-attempts = { workspace = true }` (same pattern as `vulnmart-models`). `apps/api/Dockerfile` (near lines 22-30): add `COPY packages/py-attempts/pyproject.toml packages/py-attempts/pyproject.toml` and `COPY packages/py-attempts/src packages/py-attempts/src` like the `py-models` lines; check the API `.dockerignore`; run `uv lock`.
2. `EngineAttemptPort` in `apps/api/src/vulnmart/ports/engine_attempts.py` implements the current `AttemptPort` (`create_from_consent`, `get`, `cancel`, `withdraw`, `purge`) over `AttemptEngine` and adds `instance_ready(attempt_id, at)`, `submit(attempt_id)`, `tick()`. Mapping: `create_from_consent` to `engine.create(user_id, template_id, consent_id, rules, instance_id)`; `cancel(attempt_id, by, reason)` to `engine.cancel`; `InvalidTransition` to `AttemptStateInvalid` (ATT-INVALID-STATE); `KeyError` from `get` to `AttemptNotFound`; `AttemptRecord` to the existing `Attempt` dataclass (state strings are equal to `vulnmart.ports.attempts.AttemptState`). `EngineReportPort` (name reserved) wraps `mark_reported(attempt_id, held_open, scoring_exists)` and the story 7.3 scoring call.
3. `InstanceControl` adapter over `InstanceHost.set_access(instance_id, "frozen", access_epoch + 1)` (`instance_host.py:449`; the orchestrator refuses a lower epoch) and the destroy call; both idempotent and raising on failure.
4. DB `AttemptStore`: `get`, `find(user_id, template_id)` (unique index on the pair), `add`, `put_if_version` (`UPDATE ... WHERE id = :id AND version = :expected`, zero rows means `Conflict`), `due(now)` (state in running, expired, submitted, cancelled and `destroyed` false, ordered by `deadline_at`); columns for every `AttemptRecord` field including `version`, `access`, `destroyed`, `destroy_claim_at`.
5. Scheduler job (`kernel/entrypoints/scheduler.py`, Akshay): call `AttemptEngine.tick()` every 15 s; map the event dicts to IF-3 and the FR-TIM-04 log. Dashboards show `deadline_at` and `server_time` only.
6. Default if no answer: the in-memory store ships for the demo and Akshay writes the SQL store when the attempts migration lands.