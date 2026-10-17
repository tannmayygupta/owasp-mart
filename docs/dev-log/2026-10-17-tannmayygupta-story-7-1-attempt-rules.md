# Attempt rules library: state machine, server clock, deadline and warnings (story 7.1)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (commit of this story follows; not committed when this entry was written) |
| Status | Partly done: library built and its tests passed locally; the main-session review and the developer's confirmation are still to come; nothing is wired into the API |
| Report tag | attempt rules, server clock, FR-SES-01, FR-SES-02, FR-SES-03, FR-SES-06, FR-SES-08, FR-TIM-05, D-80, D-81, D-82 |

## Requirements covered
FR-SES-01, FR-SES-02, FR-SES-03, FR-SES-06, FR-SES-08, FR-TIM-05; open question OI-22 (clock start, proposed answer); decisions D-80, D-81, D-82 (new, decided on the developer's delegation, Proposed); ADR 0041 (Proposed); handoffs H-87 (answered as a proposal), H-127 (new). Task L-22 (first of three stories; stays unticked).

## Summary (plain language, 3-5 lines)
Nothing decided when an assessment attempt starts, ends or which state may follow which. There is now a small Python package with no dependencies that holds the ten attempt states, the allowed moves, the time rules (limit, grace, warnings, freeze) and pure functions that answer "is this request still accepted", "which warnings are due", "has it expired", "may the instance be destroyed". The clock starts when the instance is ready, as the server sees it.

## Why
The platform's `AttemptPort` only had a provisional fake and the clock start (OI-22) was open. Both the API and the tests need the same rules. Source: FR-SES-01, 02, 03, 06, 08, FR-TIM-05 and architecture 04 section 10.1.

## What was built
- New uv workspace package `packages/py-attempts` (`vulnmart-attempts`, module `vulnmart_attempts`, Python 3.14, standard library only, empty dependency list).
- `states.py`: 10 states, the transition table of architecture 04 section 10.1 (21 edges, no `paused`), `can_move`, `move`, `InvalidTransition`, `CANCELLABLE`, `WITHDRAWABLE`.
- `rules.py`: frozen `Rules` (time limit 120 min, grace 60 s, warnings at 15 and 5 minutes left, freeze 15 min, reset limit 3), with validation and `to_dict` / `from_dict` for the jsonb column.
- `clock.py`: `Clock`, `SystemClock`, `FakeClock`, `require_aware`.
- `schedule.py`: `AttemptTimes`, `deadline_for`, `frozen_until_for`, `accepts_request`, `warnings_due`, `expiry_due`, `destroy_due`.

## How it works
All times are absolute UTC instants from an injected clock. The deadline is `started_at` plus the limit and is stored once; no browser value or connection state is an input. A submission is accepted until the deadline plus 60 s (the limit is inclusive: +60 s accepted, +61 s refused). Warnings are due only while the attempt is running and before the deadline, longest first, and never twice. A clock before `started_at` makes nothing due. A naive datetime raises `ValueError`; an unknown state name (such as "paused") raises `ValueError`.

## Files changed
- `packages/py-attempts/pyproject.toml` - new package
- `packages/py-attempts/src/vulnmart_attempts/{__init__,states,rules,clock,schedule}.py` - new
- `packages/py-attempts/tests/{test_states,test_rules,test_schedule,test_no_dependency}.py` - new
- `pyproject.toml` (root) - member `packages/py-attempts` added to the workspace
- `uv.lock` - the new member only (16 lines; no existing package changed)
- `docs/assets/story-7-1-attempt-rules/test-output.txt` - raw test output
- Docs: this entry, ADR 0041, `initial.md` (D-80 to D-82), `docs/dev/HANDOFFS.md`, `CHANGELOG.md`, `docs/traceability.md`, `docs/dev/dev1-tanmay.md`

## Decisions made
D-80 (clock starts at instance ready, stamped by the server; the Start button only asks for the instance), D-81 (one dependency-free package, not code in `apps/api`), D-82 (absolute UTC instants, grace 60 s, warnings 15 and 5 minutes, numbers held in `Rules`). Recorded in `docs/adr/0041-attempt-clock-scoring-and-expiry.md` (Proposed, decided on the developer's delegation, to be confirmed). Alternative for D-80: start when the candidate presses Start (rejected in the plan because cold start would count against FR-TIM-05).

## Tests
Real commands and results (raw output in `docs/assets/story-7-1-attempt-rules/test-output.txt`):
- `uv lock --check`: pass.
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests`: 153 passed in 0.35 s.
- `uv run --locked --package vulnmart-api pytest -q`: 973 passed, 7 skipped (as recorded in the plan notes).
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: pass (as recorded in the plan notes).
Traceability rows: FR-SES-01, 02, 03, 06, 08, FR-TIM-05, D-80 to D-82 in `docs/traceability.md`.

## Evidence
`docs/assets/story-7-1-attempt-rules/test-output.txt`.

## Problems met and how they were fixed
None recorded in the plan notes. The plan said "one attempt per invite"; the rule itself is enforced by the engine of story 7.2 (see its entry).

## Security notes (vulnerable parts only)
Not a vulnerable part. The rules are the platform's own integrity rules; the clock never reads a browser or connection value, so a candidate cannot pause or extend the attempt.

## Limitations and follow-ups
- Not wired to the API or the database; the state-name comparison test with `apps/api` was planned for story 7.2 and is not built.
- Numbers (120 min, 60 s grace, 15 and 5 minute warnings, 15 minute freeze, 3 resets) are placeholders held in `Rules` (OI-25).
- OI-22 is answered only as a proposal (D-80); the developer must confirm.
- Not proved live: nothing here needs the live platform, but the whole attempt flow does (stories 7.2 and later, runbook).
