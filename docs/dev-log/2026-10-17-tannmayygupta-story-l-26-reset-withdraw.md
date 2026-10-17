# Reset and withdrawal during an assessment (L-26)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet |
| Status | Partly done (engine and tests done; the `EngineAttemptPort` adapter and `AttemptResetLimit` in apps/api are not built) |
| Report tag | attempts, scoring and integrity |

## Requirements covered
FR-SES-09, FR-SES-10, C-2 (no "reset loses progress" option exists), D-22, D-91.

## Summary (plain language, 3-5 lines)
The attempt engine can now count resets (limit from the template, default 3) and handle a withdrawal: the instance is destroyed, the attempt is locked, deletion is scheduled for 7 days later, and an undo inside 7 days cancels the deletion.

## Why
FR-SES-09 and FR-SES-10 had a counter field and a state table but no engine call.

## What was built
`AttemptEngine.can_reset`, `record_reset`, `withdraw`, `undo_withdrawal`, a tick step `withdrawn` to `deleted`, errors `ResetLimitReached` and `WindowClosed`, additive `AttemptRecord` fields (`reset_count`, `withdrawn_at`, `delete_after`, `undone_at`, `deleted_at`) and additive `Rules.withdrawal_undo_days` (7).

## How it works
Reset counts only while `running` (and within deadline plus grace); in `ready` it is free and not counted; any other state raises `InvalidTransition`. The limit is checked inside the compare-and-set loop, so concurrent callers never go over it. The clock, deadline and `started_at` are never touched. Withdraw destroys the instance first (a failed destroy raises and leaves the record unchanged), then stores `withdrawn` with `delete_after`; repeating returns the same record. Undo before `delete_after` clears it and the attempt stays `withdrawn` (D-91); at or after it raises `WindowClosed`. Tick moves a withdrawn attempt to `deleted` at `delete_after` (the platform purge job deletes data on that signal).

## Files changed
- `packages/py-attempts/src/vulnmart_attempts/engine.py`, `store.py`, `rules.py`, `__init__.py` - additive changes
- `packages/py-attempts/tests/test_engine_reset.py`, `test_engine_withdraw.py` - new

## Decisions made
D-91 as written in the plan. My assumptions: the undo window is a rules value (`withdrawal_undo_days`, 7) so it is one configurable point; undo at exactly day 7 is refused (`now >= delete_after`); the in-memory store's `due()` now also returns withdrawn attempts that have a `delete_after`.

## Tests
`uv run --locked --package vulnmart-attempts pytest packages/py-attempts/tests/test_engine_reset.py packages/py-attempts/tests/test_engine_withdraw.py -q` -> 19 passed (includes an 8-thread test: exactly 3 resets succeed, 5 are refused). Full package: 350 passed.

## Evidence
Terminal output above.

## Problems met and how they were fixed
None in the run; all tests passed on the first full run.

## Security notes (vulnerable parts only)
Not a vulnerable part. Events hold ids, state and counts only.

## Limitations and follow-ups
Not built (apps/api was out of scope): `EngineAttemptPort.withdraw/can_reset/record_reset/undo_withdrawal`, `AttemptResetLimit` in `ports/errors.py`, `FakeAttemptPort` conformance test, handoff rows to Akshay.
