---
id: 9
type: bug
title: "A candidate cannot start an assessment over HTTP (startAttempt is missing)"
parent: none
covers: ["H-356", "OI-22", "D-80", "FR-SES-02"]
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# A candidate cannot start an assessment over HTTP

## Description

Handoff H-356 from Akshay (story P-30): the consent grant creates the candidate's attempt in state `ready` with no instance, IF-2 declares `startAttempt` (`POST /api/v1/attempts/{attempt_id}/start`), but the real lab API had no such route (404), and `requestInstance` takes learners only. Decision D-80 (2026-10-17) settles OI-22: the clock starts when the instance is ready; the Start button only asks for the instance.

## Reproduction

Grant consent for an invite, then `POST /api/v1/attempts/{id}/start` as the candidate: 404 REQ-ROUTE-UNKNOWN.

## Cause Hypothesis

`lab/api.py` has no route; the runtime starts only attempts it creates itself (`_begin`).

## Acceptance Criteria

1. **Start asks for the instance**
   **Given** the owner of an assessment attempt in state `ready`
   **When** they `POST .../start`
   **Then** the answer is 200 with the attempt, the instance is requested, and the attempt moves to `running` with `started_at` and `deadline_at` when the instance is ready (not at the press).
2. **A repeat press is harmless**
   **Given** a start under way or a running attempt
   **When** Start is pressed again
   **Then** the same attempt is answered and no second instance is made.
3. **Wrong kind or state is refused**
   **Given** a learner attempt, or an attempt that is submitted, withdrawn or cancelled
   **When** Start is pressed
   **Then** 409 ATT-INVALID-STATE.
4. **A stranger sees nothing**
   **Given** another signed-in user
   **When** they press Start on someone's attempt
   **Then** 404 and the attempt stays `ready`.
5. **Contract text agrees**
   **Given** IF-2
   **When** the contract checks run
   **Then** the operation text records D-80 and OI-22 as resolved; no schema changes.

## References

- source — docs/dev/HANDOFFS.md row H-356
- parent — docs/plans/2026-10-20-handoffs-h355-to-h359.md

## Notes

- Decision: D-80 (confirmed 2026-10-17), the clock starts when the instance is ready. The route keeps the 200 answer of the contract.