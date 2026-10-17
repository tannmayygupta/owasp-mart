---
title: 'Time metrics and event log (L-25): headline time, estimated active time, resets and retries, ids-only attempt log'
type: 'feature'
ticket: '4'
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

**Problem:** The report must show time beside the score (FR-TIM-01 to 04) but no code derives it. The engine already emits ids-and-metadata events through its `events` callable (story 2) and the milestone engine keeps an `EventLog` with the platform's arrival time (story 6.3); nothing turns them into headline time, estimated active time, reset and retry counts, or the attempt event log.

**Approach:** In `packages/py-attempts` add two small standard-library modules. `metrics.py`: pure functions over plain data. `headline_seconds(started_at, captures)` gives, per challenge, whole seconds from instance ready (`started_at`, D-80) to the capture (labelled "time into the assessment"); `active_seconds(stamps, idle_gap_s=300)` sums the gaps between sorted activity instants that are strictly shorter than the idle gap (a gap of 300 s or more counts zero); `reset_count` and `retry_counts` count `instance_reset` events and `flag_submitted` events per challenge. `attempt_log.py`: `AttemptLog` Protocol (`append`, `read(attempt_id)`), `InMemoryAttemptLog`, and an allow-list `EVENT_FIELDS` of the FR-TIM-04 event names (read the full list in PRD line 855 first) with the only fields each may carry (ids, state names, level, cost, result word, UTC time). `append` refuses an unknown name or an unknown field with `ValueError`. The engine's `events` callable is connected with one line: `engine = AttemptEngine(..., events=log.from_engine)`. Adapter: `EngineReportPort` (ports, story 3) gets one addition, `time(attempt_id) -> TimeMetrics` (frozen dataclass: `headline` mapping, `active_seconds`, `resets`, `retries`), built from the `AttemptLog`, the milestone times and the event log.

**Proposed (decided on the developer's delegation):**
- **D-90:** time metrics are derived on demand from the log, never stored as a running number, and use only server instants (engine clock for state events, platform arrival time for instance events, never the instance clock or a browser clock). Active time is an assessment-level estimate only; the per-challenge value is not produced (FR-DET-07 classifier accuracy is a spike and stays open). Idle gap 300 s is the PRD placeholder (OI-25). Instance cold start is not counted because the clock starts at ready (story 1). A reset or retry never moves `started_at` (FR-TIM-03 and FR-SES-09).

## Boundaries & Constraints

**Always:** the log holds ids, state names, levels, costs, result words and UTC times only (no names, emails, request bodies, flags, digests, pasted text); an event not on the allow-list is refused; functions are deterministic and read no clock; negative or out-of-order input is sorted or refused, never silently wrong; the package keeps zero dependencies (`test_no_dependency.py` stays green); every test number is a number, never a flag.

**Never:** a database, a route or a screen (the report screen is Akshay's P-26, handoff below); changing `ReportPort`, `Score` or `ChallengeResult` (the new `time` call is an addition on the adapter only); contracts or error codes; editing `apps/api` outside `ports` and `tests`; any new dependency; the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Headline time | ready at T, capture of C03 at T+754 s | 754 | none |
| Capture before ready | capture earlier than `started_at` | refused | `ValueError` |
| Active time | stamps at 0, 100, 400, 1000 s | 100 + 300 is not counted (gap 300 = 0), 600 not counted: result 100 | none |
| Gap just under | gap 299 s | counted | none |
| Many stamps same second | duplicates | counted once, gap 0 | none |
| Reset | three `instance_reset` events | `resets` 3, clock unchanged | none |
| Retry | two `flag_submitted` on C01 | `retries` C01 = 2 | none |
| Log append | event name not on the list, or a field `email` | refused | `ValueError` |
| Log read | other attempt id | empty tuple | none |

</frozen-after-approval>

## Code Map

- `packages/py-attempts/src/vulnmart_attempts/engine.py` -- `Events` callable and the event dicts (`attempt.state_changed`, `time_warning_sent`, `session_expired`, `session_submitted`, `instance_destroyed`); read for the exact shape.
- `packages/py-attempts/src/vulnmart_attempts/schedule.py` -- `AttemptTimes`; `store.py` -- `AttemptRecord.started_at`.
- `apps/api/src/vulnmart/ingest/stores.py` -- `StoredEvent.received_at`, `EventLog`, `MilestoneStore` (the capture instants).
- `apps/api/src/vulnmart/ports/` (the story 3 `EngineReportPort`) -- add `time`; `apps/api/tests/` -- adapter test.
- New: `metrics.py`, `attempt_log.py`, `packages/py-attempts/tests/test_metrics.py`, `test_attempt_log.py`.
- docs: dev-log, CHANGELOG, traceability FR-TIM-01 to 05, evidence `docs/assets/story-7-4-time-metrics/`, handoff row.

## Tasks & Acceptance

**Execution:**
- [ ] `metrics.py` + tests -- headline, active (boundary 299, 300, 301), counts, determinism
- [ ] `attempt_log.py` + tests -- allow-list, refusal of unknown name and field, ids-only property test over every event the engine emits
- [ ] engine hook test -- run a full attempt on a fake clock, the log holds start, warnings, expiry, submit, destroy in order with no other field
- [ ] `EngineReportPort.time` + adapter test
- [ ] docs -- handoff to Akshay, dev-log, CHANGELOG, traceability, story `built`

**Acceptance Criteria:**
- Given a capture 754 s after ready, then the headline is 754 and the same for every challenge of the attempt.
- Given stamps with gaps of 299 s and 300 s, then only the 299 s gap counts.
- Given a reset then a retry, then the counts rise, `started_at` and the deadline do not change.
- Given any event the engine emits, then it passes the allow-list; given an extra field, then it is refused.

## Handoffs (proposed, add rows in the same commit)

- To Akshay (P-26, report screen): the adapter exposes `time(attempt_id)`; show "time into the assessment" beside each capture and the estimated active time beside the score. Default if no answer: shown as returned.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests`
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_reports.py` (and the new adapter test file)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`
