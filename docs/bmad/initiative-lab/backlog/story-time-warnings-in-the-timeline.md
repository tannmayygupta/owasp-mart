---
id: 8
type: bug
title: "The timeline and the recruiter's report do not show the time warnings"
parent: none
covers: ["H-359", "FR-SES-03", "FR-TIM-04"]
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
---

# The timeline and the recruiter's report do not show the time warnings

## Description

Handoff H-359 from Akshay (story 2.3): the engine writes `time_warning_sent` (with `minutes_left`) to the attempt log when an attempt gets its 15 and 5 minute warnings, but `getTimeline` does not map it, so a recruiter's report cannot show when the candidate was told time was running out.

## Reproduction

Start an attempt, move the clock to 14 minutes before its deadline, run the lab tick, read `GET /api/v1/attempts/{id}/timeline`: only `attempt.started` is listed.

## Cause Hypothesis

`TIMELINE_TYPES` in `lab/api.py` has no entry for `time_warning_sent`, and the IF-2 timeline type list has no value for it.

## Acceptance Criteria

1. **The warnings are in the timeline**
   **Given** an attempt that received both warnings
   **When** the timeline is read
   **Then** it lists `attempt.time_warning` twice, with `minutes_left` 15 and 5, in order, once each however often the tick runs.
2. **Only a sound number is shown**
   **Given** a warning event whose number is not a whole number of 1 to 1440
   **When** the timeline is read
   **Then** that event is left out; no other entry carries `minutes_left`.
3. **Contract, mock and clients agree**
   **Given** IF-2
   **When** the contract checks run
   **Then** the new type and member validate, the examples, the fake lab, the bundle and the generated clients are current, and the change is declared BREAKING with a raised major version as the repository rule requires for a new response enum value.
4. **The recruiter sees it**
   **Given** the recruiter's candidate page
   **When** the timeline has a warning
   **Then** the page shows "Time warning: N minutes left"; an unknown type still shows as text.

## References

- parent — docs/plans/2026-10-20-handoffs-h355-to-h359.md
- source — docs/dev/HANDOFFS.md row H-359

## Notes

- Decision: 2026-10-20, the timeline lists the warnings (the handoff's proposal), as the type `attempt.time_warning` with `minutes_left`.
- Decision: the contract version is 2.0.0 because `scripts/check-contract-rules.mjs` requires a major step for a new response enum value (D-46).
