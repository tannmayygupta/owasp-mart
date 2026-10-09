---
id: 4
type: story
title: "Orchestrator API (IF-5) and fake orchestrator"
parent: epic-lab-baseline
covers: [LB-5]
after: [1]
hitl: false
risk: medium
---

# Orchestrator API (IF-5) and fake orchestrator

## Description

Authors the orchestrator HTTP contract, the `InstanceHost` Protocol the orchestrator drives, and a fake orchestrator with a `FakeInstanceHost` that obey it.

## Acceptance Criteria

Verify: A client built from the contract creates, resets and destroys instances against the fake, and the fake host passes the same Protocol tests the real one must pass later.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md

## Notes

- Decision (2026-10-09, Tanmay): story approved as the fourth task of sprint 1. Not an early pull request: it goes on the sprint branch `sprint-1-tanmay`.
- Decision (2026-10-09, D-37): review by Akshay (consumer of the protocol) is optional; he is told in the team chat.
- Assumption: the planning step settles with Tanmay (a) where the Python `InstanceHost` protocol lives, because `apps/api` is stream P's (P-06) and no Python code exists yet, (b) the first Python test tooling and its pinned version, (c) how the OpenAPI contract is checked and how the client is made (ADR 0012 tools are unconfirmed); each is recorded in the plan.
- Source: architecture 07 section 3.3 (IF-5 calls), section 3.1 (IF-5 row), 3.6 (errors), 06 (orchestrator calls signed, nonce and timestamp), 05 (provision flow), ADR 0010 (orchestrator privileges); instance contract (`contracts/instance/`) for the template and events contract (`contracts/events/`) for state reports.
