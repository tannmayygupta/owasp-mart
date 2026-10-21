# 0096. Extra time for a running candidate attempt, and an open-attempts list for the admin

- **Status:** Accepted (the leader instructed the refresh of the scenario matrix on 2026-10-21 and asked for the scenarios no package owned to be implemented where the backend allows it)
- **Date:** 2026-10-21
- **Deciders:** the leader (tannmayygupta) with Claude
- **Requirements:** C-30, R-25, A-27, R-20 of `docs/audit/2026-10-21-role-scenarios.md`; FR-SES-07 family; D-07; D-102

## Context
Four scenarios had no owner. A recruiter could not give a candidate extra time (an accommodation), the admin could not see which assessments wait or fail, and the report's technique label was always null. Write-ups (C-37, R-30) are a larger feature and are not part of this decision.
The deadline of an attempt is stored once. The instance has a fixed lifetime set by the orchestrator when it is made (the template's time limit plus a 30 minute margin, at least 240 minutes): the host has no call to lengthen it.

## Options considered
1. Let the recruiter move the deadline of a running attempt by any amount. Simple, but the instance could be destroyed by the orchestrator before the new deadline, in the middle of the assessment.
2. Add a call to the orchestrator to extend an instance. Right in the long run, but it changes IF-5 and the orchestrator and is not needed for the accommodations in view (minutes, not hours).
3. Extend the deadline only inside what is left of the instance's lifetime (5 minutes short of it) and cap all extra time of one attempt at 240 minutes. No orchestrator change, safe, explicit.
4. Reopen an ended attempt. Rejected: the instance is destroyed and its keys are shredded at the end; a reopen would be a second attempt, which FR-SES-06 forbids.

## Decision
Option 3. `extendAttempt` (`POST /api/v1/attempts/{id}/extend`, `{minutes: 5..240}`, IF-2 2.3.0) for the recruiter of the owning company, only on a `running` company attempt whose deadline has not passed; warnings that are due again are sent again; every extension is written to the ids-only attempt log (`time_extended`, with the recruiter's id). The engine (`vulnmart_attempts`) keeps the total in `extended_minutes`.
The admin list is `listOpenAttempts` (`GET /api/v1/admin/attempts`, IF-1 1.9.0): ids, states and instants of the `ready` and `running` attempts with an `issue` (`waiting`, `failing`, `none`); a failed start leaves the attempt `ready`, so it is `waiting`. The read is audited.
The technique label of the report is the catalogue's fixed tag layer (title and primary CWE) for a challenge with a milestone; the automatic detection layer (spike S-6) is not built and is not claimed.

## Consequences
Extra time is a few hours at most and never outlives the instance. An ended attempt stays ended. The orchestrator is untouched; if longer accommodations are ever needed, option 2 is the next step. The admin sees waiting and crashed attempts without opening candidate data. A candidate's timeline does not show the extension (the contract's timeline types were not widened).

## Evidence
`packages/py-attempts/tests/test_engine_extend.py`, `apps/api/tests/test_scenarios_refresh.py` (`test_c30_r25_...`, `test_a27_...`, `test_r20_...`), `apps/api/tests/test_lab_contract.py`, `pnpm run contracts:rules` (22 PASS), `pnpm run api:check`. No external sources were needed.