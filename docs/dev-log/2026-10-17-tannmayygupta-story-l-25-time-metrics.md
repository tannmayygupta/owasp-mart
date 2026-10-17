# Time metrics and event log (L-25)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet |
| Status | Partly done (library done and tested; the `EngineReportPort.time` adapter in apps/api is not built) |
| Report tag | attempts, scoring and integrity |

## Requirements covered
FR-TIM-01, FR-TIM-02, FR-TIM-03, FR-TIM-04, FR-TIM-05 (clock is the injected server clock), D-22, D-90.

## Summary (plain language, 3-5 lines)
The library can now turn the attempt events into the numbers the report shows next to the score: time into the assessment per capture, estimated active time, number of resets and retries per challenge. It also keeps an ids-only event log that refuses any event name or field that is not on a fixed list.

## Why
FR-TIM-01 to 04: time must be shown beside the score, and the log must hold only ids and UTC times.

## What was built
`metrics.py` (headline, active time, counts, a `TimeMetrics` bundle) and `attempt_log.py` (allow-list `EVENT_FIELDS`, `InMemoryAttemptLog`, `from_engine` hook).

## How it works
Pure functions over plain data, derived on demand, nothing stored or read from a clock. Headline = whole seconds from `started_at` to the capture; a capture before the start is refused. Active time = sum of the gaps between sorted, de-duplicated activity instants that are strictly under 300 s. The log accepts only the FR-TIM-04 event names (plus the engine's withdrawal and review events) and, per event, only the listed fields; values must be text, numbers or true/false and at most 100 characters. `log.from_engine` is passed as the engine's `events` callable; the engine's `attempt.state_changed` to `running` is logged as `session_started`, other state changes are skipped because named events already cover them.

## Files changed
- `packages/py-attempts/src/vulnmart_attempts/metrics.py` - new
- `packages/py-attempts/src/vulnmart_attempts/attempt_log.py` - new
- `packages/py-attempts/tests/test_metrics.py`, `test_attempt_log.py` - new

## Decisions made
Followed D-90 as written in the plan (derived on demand, 300 s placeholder idle gap, assessment-level active time only). Assumption of mine: the engine's start-of-clock event is logged as `session_started`, because the plan says the log holds "start" but no event is named for the engine's state change.

## Tests
`uv run --locked --package vulnmart-attempts pytest packages/py-attempts/tests/test_metrics.py packages/py-attempts/tests/test_attempt_log.py -q` -> 30 passed. Full package: `uv run --locked --package vulnmart-attempts pytest packages/py-attempts -q` -> 350 passed (254 before the four stories). Expected numbers (754 s, gaps 299/300/301, 100 s example) come from the PRD and the story table. Traceability rows: not edited by me (left to the owner).

## Evidence
Terminal output above; no screenshots (no screen).

## Problems met and how they were fixed
The engine swallows event sink errors, so a rejected event would be silent. The "every engine event passes the allow-list" test therefore validates each emitted payload directly instead of only reading the log.

## Security notes (vulnerable parts only)
Not a vulnerable part. No flag values or secrets are in the code or tests.

## Limitations and follow-ups
`EngineReportPort.time(attempt_id)` (apps/api ports) is not built: that folder was out of scope for this run. Handoff to Akshay (P-26) still to be added by the owner.
