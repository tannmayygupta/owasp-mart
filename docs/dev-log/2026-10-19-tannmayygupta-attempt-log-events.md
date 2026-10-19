# FR-TIM-04 events the lab never wrote

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | tannmayygupta |
| Branch / commit | l-attempt-log-events |
| Status | Partly done: the lab-owned events are written; the platform-owned ones are not |
| Report tag | lab, L-25, FR-TIM-04 |

## Requirements covered
L-25, FR-TIM-04, D-90.

## Summary
The ids-only attempt log lists events from the allow-list that nothing wrote. The lab now writes instance_requested, instance_ready and flag_auto_detected (a real flag seen by the sidecar and credited). Order for a start: instance_requested, instance_ready, session_started (from the engine). Ids only: the auto-detected line carries the challenge key and the instance id, never the flag.

## Why
The 2026-10-18 audit: FR-TIM-04 events on the allow-list are never emitted.

## What was built
Three journal calls in LabRuntime (_begin, _finish, _on_event) and one test.

## How it works
_journal appends to the attempt log; a failing log never undoes the step.

## Files changed
- apps/api/src/vulnmart/lab/runtime.py, apps/api/tests/test_lab_runtime.py, docs/dev/dev1-tanmay.md, CHANGELOG.md

## Decisions made
None.

## Tests
- tests/test_lab_runtime.py, test_lab_api.py, test_lab_loop.py, test_lab_review_reset_withdraw.py: 56 passed. The pinned log-order test now expects the two new lines first. The full suite runs in CI.

## Evidence
Pull request checks.

## Problems met and how they were fixed
The engine's own bridge already writes session_started after the ready step, so instance_ready is journaled before the engine call to keep the true order.

## Security notes
No flag value is written.

## Limitations and follow-ups
Not written by the lab, and not the lab's to write: invite_created, invite_opened, consent_given, recruiter_viewed_report (stream P). request_seen (a summary marker per challenge) is not written. L-25 stays open for those.
