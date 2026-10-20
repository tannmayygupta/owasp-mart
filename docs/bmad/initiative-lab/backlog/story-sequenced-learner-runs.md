---
id: 6
type: story
title: "Sequenced learner runs: one challenge at a time, a countdown each, new runs, account points"
parent: none
covers: ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11", "FR-DSH-01", "FR-HNT-01", "FR-SES-06"]
after: [3]
assignee: ""
refined: true
hitl: false
risk: high
severity: P2
---

# Sequenced learner runs: one challenge at a time, a countdown each, new runs, account points

## Description

A learner's lab was one attempt for all eleven challenges with a 120-minute limit and one attempt per learner for ever. A learner whose run ended (time out) saw no Start button and no challenges (reported by the developer on the live lab). The developer decided: one challenge at a time with the others not visible, a countdown by tier (Easy 20, Medium 40, Hard 60 minutes) started when the learner begins the challenge, the challenge locked when time is up, a new run after a finished one, and the best result per challenge counted on the account. ADR 0063 records the decision.

## Acceptance Criteria

1. **Only the current challenge exists**
   **Given** a sequenced run
   **When** the challenge list is read
   **Then** it holds the challenges solved or timed out and the current one, with `total`, `current_key` and the countdown fields; later challenges answer 404 on begin, hints and flags.
2. **The countdown follows the tier**
   **Given** the current challenge
   **When** the learner begins it
   **Then** its clock runs 20, 40 or 60 minutes; repeating begin changes nothing; flags, hints and milestone events count only while it is active.
3. **A challenge ends and the next one comes**
   **Given** an active challenge
   **When** its flag is captured or its time is over
   **Then** it is `solved` or `expired`, earns no more, and the next challenge becomes current; the run is submitted when all are over.
4. **A finished run can be followed by a new one**
   **Given** a finished learner run
   **When** the learner starts again
   **Then** a new run is created and the old one stays as history; a company attempt still never restarts.
5. **Account points**
   **Given** several runs
   **When** the account progress is read
   **Then** it holds the best points per challenge and the total out of 1000.
6. **Stored and contracted**
   **Given** the platform and the mock
   **When** the contract checks and the tests run
   **Then** IF-2 1.3.0 and table owners 2.2.0 validate, the migration goes up and down on Postgres, and the mock answers the new operations.

## References

- source — docs/adr/0063-sequenced-learner-runs-with-a-countdown-per-challenge.md
- source — contracts/api/lab/lab.openapi.yaml, contracts/api/lab/lab-api.md

## Notes

- Decision: 2026-10-20, the developer chose the per-challenge timer, locking on expiry, new runs after a finished run, a run limit of the sum plus 30 minutes, and best-per-challenge account points.
- Assumption: challenges run in catalogue order C01 to C11.
- The console that uses this is story 7.
