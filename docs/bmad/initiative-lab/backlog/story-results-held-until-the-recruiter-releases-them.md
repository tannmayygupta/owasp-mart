---
id: 10
type: bug
title: "A candidate sees results the invite says are released later"
parent: none
covers: ["H-355", "OI-15", "FR-DSH-02"]
after: ["9"]
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# A candidate sees results the invite says are released later

## Description

Handoff H-355 (Akshay, P-26/P-27): OI-15 (answered 2026-10-18) makes results visibility a recruiter setting: the invite's rules carry `results_visibility` (`after_submit` or `after_release`). The candidate page hides the results, but the lab's `getScore` and `listChallenges` still answered the candidate's own results at any time, and the rule did not reach the attempt. There was no recruiter action to release.

## Reproduction

Invite with `after_release`, candidate finishes, then `GET /api/v1/attempts/{id}/score` as the candidate: 200 with the score.

## Cause Hypothesis

`attempt_rules` copied only `time_limit_min` and `reset_limit` into the attempt's rules; the lab routes had no visibility check; no release operation existed.

## Acceptance Criteria

1. **The rule reaches the attempt**
   **Given** an invite whose rules say `after_release`
   **When** the attempt is created from the consent
   **Then** the attempt's stored rules say so; a value other than the two is refused; old stored rules still load (default `after_submit`).
2. **The candidate sees nothing earned until the release**
   **Given** a company attempt with `after_release`, not released
   **When** the candidate calls `getScore` / `listChallenges`
   **Then** `getScore` is 404 and `listChallenges` shows no milestone, no solved, no held; the recruiter of the company sees everything as before.
3. **The recruiter releases**
   **Given** a finished attempt (submitted, reported, expired)
   **When** the recruiter of the owning company calls `releaseResults`
   **Then** the attempt reads `results_released: true`, the candidate sees the score, repeating changes nothing, one `results_released` line is in the attempt log; a running attempt is 409; the candidate and other companies get 404.
4. **The default and learners are untouched**
   **Given** `after_submit` or a learner's practice
   **Then** nothing is held back and no `results_released` member is shown.
5. **Contract and pages agree**
   **Then** IF-2 2.1.0 (additive: the operation and the optional member), examples, mock, bundle and clients are current; the recruiter page has a release button and the candidate page shows results once released.

## References

- source — docs/dev/HANDOFFS.md row H-355
- parent — docs/plans/2026-10-20-handoffs-h355-to-h359.md

## Notes

- Decision: OI-15 (2026-10-18). The release is recorded as an attempt-log event (`results_released`, with the recruiter's id) instead of a new column, so no migration is needed; the route appends to the log directly so a failed write is an error, not a silent loss.
- Scope: H-355 also names the hint and rate-limit settings reaching the attempt; hints are decided elsewhere (`hints_enabled`), so only results visibility is carried here.