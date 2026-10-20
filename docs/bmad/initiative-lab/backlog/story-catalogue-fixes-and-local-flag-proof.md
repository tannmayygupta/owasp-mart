---
id: 3
type: story
title: "Fix the catalogue gaps and prove, on one machine, that every challenge shows its own flag"
parent: none
covers: ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11", "FR-HNT-01", "FR-HNT-02"]
after: [2]
assignee: ""
refined: false
hitl: true
risk: medium
---

# Fix the catalogue gaps and prove, on one machine, that every challenge shows its own flag

## Description

The audit (story 2) found naming and wording gaps in the catalogue. The developer asked to take over the shop work and make every challenge complete end to end. This story fixes the catalogue gaps and adds a local run that starts the real shop the way an instance starts it, plants a fresh flag per challenge, runs each exploit and checks the right flag comes back.

## Acceptance Criteria

1. **Titles use the official OWASP 2025 names**
   **Given** the catalogue
   **When** C06 and C09 are read
   **Then** C06 is "Software Supply Chain Failures" and C09 is "Security Logging and Alerting Failures", and the catalogue check passes.
2. **Hint 3 of C02 and C04 leaves the check to the learner**
   **Given** the two hints
   **When** read
   **Then** each gives a direction to test, not the full recipe.
3. **C06 milestone signals describe what the platform reads**
   **Given** the catalogue entry of C06
   **When** read
   **Then** the three signals name the import job events and the flag in the preview response.
4. **Every challenge returns its own flag**
   **Given** a shop started with the real injector and one fresh flag per challenge
   **When** each exploit runs
   **Then** the flag planted for that challenge is in the responses and no flag of another challenge is.
5. **Tests**
   **Given** the suite
   **When** it runs
   **Then** the helpers of the new script are unit tested and the existing catalogue and lab API tests pass.

## References

- parent — docs/bmad/initiative-lab/backlog/story-audit-all-eleven-challenges.md
- source — docs/dev-log/2026-10-20-tannmayygupta-challenge-audit.md

## Notes

- Decision: 2026-10-20, the developer asked Tanmay's session to take over the shop and challenge work (Sahil is not continuing). `initial.md` is not changed by this story; the developer confirms any change to the decisions.
- Decision: 2026-10-20, the audit gap about `fixed_build` is withdrawn: the schema defines it as a logical reference to the env switch, not a folder.
