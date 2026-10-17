---
title: 'Attempt rules library: state machine, server clock, deadline and warning rules (pure, injectable clock)'
type: 'feature'
ticket: '1'
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
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/architecture/04-data-and-state.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing decides when an assessment attempt starts, when it ends, which state may follow which, or which warnings are due (FR-SES-01, 02, 03, 06, 08, FR-TIM-05). The platform's `AttemptPort` has only a provisional fake. The clock start is open (OI-22, handoff H-87). Both Akshay's API and the tests need the same rules.

**Approach:** A new uv workspace package `packages/py-attempts` (distribution `vulnmart-attempts`, module `vulnmart_attempts`, Python 3.14, standard library only, no I/O, no dependency). It holds: (1) `states.py` the 10 attempt states and the transition table of architecture 04 section 10.1 (no `paused`), `can_move(from, to)` and `move(...)` that refuse a skip; (2) `rules.py` a frozen `Rules` copied from the template at start: time limit minutes (default 120), grace seconds (60), warnings at 15 and 5 minutes left, freeze minutes (15), reset limit (3); (3) `clock.py` `Clock = Callable[[], datetime]` (aware UTC), `SystemClock`, `FakeClock`; (4) `schedule.py` pure functions of one `AttemptTimes` record (`ready_at`, `started_at`, `deadline_at`, `submitted_at`, `frozen_until`): `deadline_for(started_at, rules)`, `accepts_request(now, times, rules)` (deadline plus grace), `warnings_due(now, times, rules, already_sent)`, `expiry_due(now, times)`, `destroy_due(now, times)`. Decisions below, decided on the developer's delegation, for the main session to record in `initial.md` and ADR files.

**Proposed (decided on the developer's delegation):**
- **D-80 (OI-22):** the assessment clock starts when the instance is ready, stamped by the server (D-22, RS-A, RS-C favour it). The attempt moves `ready` to `running` at that moment, `started_at` = `ready_at`, `deadline_at` = `started_at` + time limit. The candidate's Start button (route `POST /api/v1/attempts/{id}/start`, H-87) only asks for the instance; it has no effect on the clock, so cold start never counts (FR-TIM-05) and an attempt cannot sit in `ready` with a running clock. If the instance never becomes ready the clock never starts (cancel handles it).
- **D-81:** the rules and the engine are one dependency-free package `packages/py-attempts`, not code in `apps/api` (stream L may write only ports and tests there). Akshay's API imports it and supplies the database store (story 2). Thin port adapters live in `apps/api/src/vulnmart/ports/` (stories 2 and 3).
- **D-82:** all timing is absolute UTC instants from an injected clock; the deadline is stored once and never recomputed from elapsed counters, the browser clock and the connection are never inputs. In-flight grace is 60 s after the deadline for submissions only; warnings at 15 and 5 minutes left; all numbers are placeholders held in `Rules` (tunable per template, OI-25).

## Boundaries & Constraints

**Always:** pure functions; the same inputs give the same answer; naive datetimes are refused (a `ValueError`); transitions are exactly the table (including `consent` to `withdrawn`, `running` to `expired`, `expired` to `submitted`, withdrawn to deleted); one attempt per invite is a rule the engine of story 2 enforces, here only the `Rules`/state support it; state names equal the strings of `vulnmart.ports.attempts.AttemptState` (a test in `apps/api/tests` compares the two lists so they cannot drift). Test every one of the 10 x 10 pairs against the table.

**Never:** an I/O call, a database, a thread, `time.sleep`, reading the system clock outside `SystemClock`; a `paused` state; changing any contract file (`contracts/**`), the IF-2 attempt shape or an error code; editing `apps/api` outside `ports` and `tests`; editing another developer's tracker folder; commits, pushes, checkout, stash, reset; real flag values or secrets in tests or docs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Start | instance ready at T, limit 120 | `started_at` T, `deadline_at` T + 120 min | none |
| Skip a state | `invited` to `running` | refused | `InvalidTransition` |
| Allowed ones | every edge of the table | accepted | none |
| Paused | any state to `paused` | no such state | `ValueError` |
| Request at deadline + 30 s | submission in flight | accepted (grace) | none |
| Request at deadline + 61 s | any request | refused | `accepts_request` False |
| Warnings | now = deadline - 14 min, none sent | 15-minute warning due; 5 not due | none |
| Warnings late | now = deadline - 3 min, none sent | both due, in order; never twice | none |
| Lost connection | no heartbeat for hours, now past deadline | `expiry_due` True | none |
| Clock moved back | now before `started_at` | nothing due, no error | none |
| Naive time | `datetime` without tzinfo | refused | `ValueError` |
| Freeze end | `frozen_until` = submitted + 15 min | `destroy_due` True at that instant, not before | none |

</frozen-after-approval>

## Code Map

- `packages/py-attempts/pyproject.toml` (new) -- model on `packages/py-models/pyproject.toml:1-18` and `apps/orchestrator/pyproject.toml:23-28`: name `vulnmart-attempts`, `requires-python = "==3.14.*"`, no dependencies, dev group `pytest==9.1.1`, `uv_build==0.12.23`, `module-name = "vulnmart_attempts"`.
- `packages/py-attempts/src/vulnmart_attempts/{__init__,states,rules,clock,schedule}.py` (new).
- `packages/py-attempts/tests/` (new): `test_states.py`, `test_rules.py`, `test_schedule.py`, `test_no_dependency.py` (the package imports only the standard library: read `pyproject.toml` and check the dependency list is empty).
- `pyproject.toml:14` (repo root) -- `members = ["apps/api", "apps/orchestrator", "packages/py-models"]`: add `"packages/py-attempts"`; then `uv lock` (adds the member only; no version of any existing package may change, check `git diff uv.lock`).
- `apps/api/src/vulnmart/ports/attempts.py:15-35` (read only here) -- `AttemptState`, `CANCELLABLE`, `WITHDRAWABLE`: the library table must agree with them.
- `apps/api/tests/test_ports_lab.py` (add one test) -- `AttemptState` values equal the library's; needs the dependency from story 2, so this test lands in story 2 (list it there, not here).
- `docs/architecture/04-data-and-state.md:222-251` (read) -- the table of section 10.1 and the note that the freeze is `frozen_until`, not a state.
- Docs: `docs/dev/HANDOFFS.md` rows below, dev-log, CHANGELOG, traceability (FR-SES-01, 02, 03, 06, 08, FR-TIM-05), `docs/dev/dev1-tanmay.md` L-22 stays unticked until story 2 closes.

## Tasks & Acceptance

**Execution:**
- [ ] `pyproject.toml` (root) and `packages/py-attempts/pyproject.toml` -- new member, `uv lock`
- [ ] `states.py`, `rules.py`, `clock.py`, `schedule.py` -- as in the Approach
- [ ] tests -- every row of the matrix, the 100-pair transition test, a loop test: for 1 to 3000 random instants (seeded `random.Random(7)`) around the deadline, `accepts_request`, `warnings_due` and `expiry_due` agree with a slow reference written in the test
- [ ] handoff rows (H-127 for Akshay) and docs as in the Code Map

**Acceptance Criteria:**
- Given an attempt whose instance became ready at T, then `deadline_at` is T + 120 minutes and nothing in the library reads a browser or connection value.
- Given the 100 pairs of states, then exactly the edges of architecture 04 section 10.1 are accepted.
- Given now = deadline + 61 s, then `accepts_request` is False; at + 59 s it is True.
- Given the warning instants 15 and 5 minutes before the deadline, then each is due once and the second only after the first.
- Given a naive datetime, then a `ValueError` is raised.

## Verification

**Commands (Windows dev PC, from the repository root):**
- `uv lock` then `git diff --stat uv.lock` -- expected: only the new member added
- `uv lock --check` -- expected: pass
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests` -- expected: pass
- `uv run --locked --package vulnmart-api pytest -q` -- expected: pass (the API suite is unchanged)
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs` -- expected: pass

**Provable locally:** everything in this story. **Needs the live platform:** nothing; the real database store and scheduler wiring are story 2 and Akshay's part.

## Handoffs to add in the same commit (rows in `docs/dev/HANDOFFS.md`)

- **H-127 (to P-26, P-05, Akshay):** the attempt rules package exists; the clock starts at instance ready (D-80, answers H-87: keep the start route as "ask for the instance", the clock ignores it); please confirm the `attempts` table carries `ready_at`, `started_at`, `deadline_at`, `submitted_at`, `frozen_until` and `rules jsonb` as in architecture 04 section 2.5 (they do) plus a small `warnings_sent` array and `resets_used` integer (new, needed by story 2). Default if no answer: L adds them to the proposal in `docs/dev/messages/` and Akshay includes them in the attempts migration.

## Implementation Notes

Built 2026-10-17 (status built; review and tests by the main session still to come).

- New package `packages/py-attempts` (`vulnmart-attempts`, module `vulnmart_attempts`, standard library only, empty dependency list, dev group pytest 9.1.1, uv_build 0.12.23). Added to the root workspace `members`; `uv lock` added only the new member (16 lines in `uv.lock`, no existing package changed).
- Modules: `states.py` (10 states, `TRANSITIONS` of arch 04 section 10.1 with 21 edges, `can_move`, `move`, `InvalidTransition`, `CANCELLABLE`, `WITHDRAWABLE`), `rules.py` (frozen `Rules` with validation, `to_dict`/`from_dict` for the jsonb column), `clock.py` (`Clock`, `SystemClock`, `FakeClock`, `require_aware`), `schedule.py` (`AttemptTimes`, `deadline_for`, `frozen_until_for`, `accepts_request`, `warnings_due`, `expiry_due`, `destroy_due`).
- Choices inside the plan: an unknown state name such as "paused" raises `ValueError` (from the StrEnum); warnings are due only while running before the deadline and not submitted, returned longest first; a clock before `started_at` makes nothing due; the grace limit is inclusive (deadline + 60 s accepted, + 61 s refused).
- Tests: `test_states.py` (100-pair table test, forbidden skips, reopen), `test_rules.py`, `test_schedule.py` (matrix rows, seeded 3000-instant loop against a slow reference, naive datetimes), `test_no_dependency.py`.
- Real results: `uv lock --check` pass; `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests` gives 153 passed in 0.35 s (raw output in `docs/assets/story-7-1-attempt-rules/test-output.txt`); `uv run --locked --package vulnmart-api pytest -q` gives 973 passed, 7 skipped; `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs` pass.
- Not done here (by instruction): the apps/api state-name comparison test (lands in story 2), handoff H-127, dev-log, CHANGELOG, traceability.