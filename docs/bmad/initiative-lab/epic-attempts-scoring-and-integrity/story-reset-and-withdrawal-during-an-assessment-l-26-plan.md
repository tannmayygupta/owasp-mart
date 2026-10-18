---
title: 'Reset and withdrawal during an assessment (L-26)'
type: 'feature'
ticket: '5'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/prd/PRD.md', '{project-root}/docs/architecture/04-data-and-api.md']
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** FR-SES-09 (a candidate may reset the instance within the template limit, new flags, milestones and clock untouched) and FR-SES-10 (withdrawal locks the attempt, destroys the instance, notifies the recruiter, schedules deletion after a 7-day undo window) have a counter field and a state table (story 1) but no engine call. `AttemptPort.withdraw` exists as a protocol call and the engine only has `cancel`.

**Approach:** In `packages/py-attempts`: `AttemptRecord` gets additive fields `reset_count` (int, 0) and `withdrawn_at`, `delete_after` (datetime or None). `AttemptEngine.record_reset(attempt_id)` is called after a successful platform reset: allowed only in `running` (a reset in `ready` is free and not counted, a reset in any other state is refused), refused with `ResetLimitReached` when `reset_count >= rules.reset_limit`, otherwise increments the count with compare-and-set and emits `instance_reset` (count, no other field). Order for the platform: `can_reset(attempt_id)` first (pure check, no side effect), then the instance reset (IF-5, new epoch and flags), then `record_reset`. `AttemptEngine.withdraw(attempt_id)`: allowed from `consent`, `ready`, `running`, `submitted` (table of story 1); moves to `withdrawn`, calls `InstanceControl.destroy` when an instance exists (idempotent, a failed destroy leaves the record unchanged so the next call retries), sets `withdrawn_at` and `delete_after = withdrawn_at + 7 days`, emits `attempt_withdrawn` (ids only, the recruiter notification is the platform's `OutboxPort` consumer: the event is the trigger). `undo_withdrawal(attempt_id)` inside the window clears `delete_after` and records `withdrawal_undone`; `tick()` moves a `withdrawn` attempt to `deleted` once `delete_after` has passed (the platform's purge job does the data deletion, `AttemptPort.purge`). The adapter `EngineAttemptPort` (story 2) gets `withdraw`, `can_reset`, `record_reset`, `undo_withdrawal` and maps `ResetLimitReached` to a new `AttemptResetLimit` in `ports/errors.py` (additive).

**Proposed (decided on the developer's delegation):**
- **D-91:** a reset counts only while `running`; the clock, the deadline, the best milestone per challenge and the hint levels survive (they are facts keyed by attempt, not by instance epoch); flags are new because the epoch changes (the instance side, story 3.x). Withdrawal is final for the attempt: the instance is destroyed at once and the attempt stays `withdrawn`; an undo inside 7 days only cancels the scheduled deletion and re-keeps the candidate's record, it does not revive the attempt or the instance (the clock ran, and the state table has no edge out of `withdrawn` except to `deleted`). If the recruiter wants the candidate to continue they issue a new invite. A later reading of OI-25 or the guide may change this: marked Proposed.

## Boundaries & Constraints

**Always:** all instants from the injected clock; each call idempotent (a repeated `withdraw` returns the current record, a repeated tick does nothing more); a withdrawn attempt never scores, never returns evidence to the recruiter beyond what the consent record allows (that gating is the platform's, FR-PRV-02); the minimal consent record is not touched here; the event dicts hold ids and counts only; `reset_count` is never decreased.

**Never:** a candidate choosing "reset loses progress" (C-2): there is no such option or parameter; deleting data (purge is the platform's job); changing the state table, IF-2, IF-5 or any error code of the contracts; adding a dependency; editing `apps/api` outside `ports` and `tests`; the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reset 1 to 3 | `running`, limit 3 | count 1, 2, 3; deadline and `started_at` unchanged | none |
| Reset 4 | count 3 | refused before touching the instance | `ResetLimitReached` to `AttemptResetLimit` |
| Reset in `ready` | not started | allowed by platform, not counted | none |
| Reset after expiry | `submitted` | refused | `InvalidTransition` mapped to ATT-INVALID-STATE |
| Two resets at once | two callers | compare-and-set: both succeed up to the limit, never over | `Conflict` retried |
| Withdraw `running` | instance exists | `withdrawn`, instance destroyed, `delete_after` = +7 days | failed destroy: unchanged, retry |
| Withdraw twice | repeat | same record | none |
| Withdraw `reported` or `cancelled` | not allowed | refused | `InvalidTransition` |
| Undo day 6 | inside window | `delete_after` cleared, attempt stays `withdrawn` | none |
| Undo day 8 | after window | refused | `WindowClosed` |
| Tick day 7 | `delete_after` passed, no undo | `deleted` | none |

</frozen-after-approval>

## Code Map

- `packages/py-attempts/src/vulnmart_attempts/states.py` -- `WITHDRAWABLE`, transitions (not changed); `store.py` -- `AttemptRecord` (additive fields) and the in-memory store; `engine.py` -- `cancel` is the template for destroy-then-record; `rules.py` -- `reset_limit`.
- `apps/api/src/vulnmart/ports/attempts.py` -- `AttemptPort.withdraw`, `WITHDRAWABLE`; the story 2 `EngineAttemptPort` in `ports/`; `ports/errors.py` (additive error).
- `apps/api/src/vulnmart/ports/lab_fakes.py` -- `FakeAttemptPort.withdraw` for the shared protocol test.
- Tests: `packages/py-attempts/tests/test_engine_reset.py`, `test_engine_withdraw.py`; `apps/api/tests/` adapter conformance additions.
- docs: dev-log, CHANGELOG, traceability FR-SES-09, FR-SES-10, evidence `docs/assets/story-7-5-reset-withdraw/`, handoff rows.

## Tasks & Acceptance

**Execution:**
- [ ] `store.py`, `engine.py` -- fields, `can_reset`, `record_reset`, `withdraw`, `undo_withdrawal`, tick step to `deleted`
- [ ] tests -- the whole matrix on a fake clock; a concurrency test (two threads) for the reset counter
- [ ] `EngineAttemptPort` additions + `AttemptResetLimit` + protocol conformance test against `FakeAttemptPort`
- [ ] docs -- handoffs, dev-log, CHANGELOG, traceability, story `built`

**Acceptance Criteria:**
- Given three resets in `running`, then the fourth is refused and the deadline and milestones are unchanged.
- Given a withdrawal while `running`, then the instance control received exactly one destroy, the attempt is `withdrawn`, `delete_after` is 7 days later and an `attempt_withdrawn` event holds ids only.
- Given an undo inside 7 days, then no deletion happens; given none, the tick after day 7 moves it to `deleted`.

## Handoffs (proposed, add rows in the same commit)

- To Akshay (P-xx withdrawal screen, notification consumer): the `attempt_withdrawn` event is the trigger for the recruiter notice (`OutboxPort`), data purge runs at `delete_after`; undo keeps the attempt `withdrawn` (D-91). Default if no answer: as written.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests`
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_ports_lab.py` (and the new adapter tests)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`
