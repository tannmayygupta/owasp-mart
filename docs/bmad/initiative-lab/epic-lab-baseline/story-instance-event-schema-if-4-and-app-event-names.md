---
id: 3
type: story
title: "Instance event schema (IF-4) and app-event names"
parent: epic-lab-baseline
covers: [LB-4]
after: [2]
hitl: false
risk: medium
---

# Instance event schema (IF-4) and app-event names

## Description

Defines the signed events sidecars and the shop send to ingest and the app-event name list, with a fake ingest that validates them.

## Acceptance Criteria

Verify: Every example event validates, the fake ingest rejects a malformed or oversize one, and stream T has approved the names it emits.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md

## Notes

- Decision (2026-10-08, Tanmay): story approved as the third task of sprint 1; early pull request (branch `shared-L-03`) because Sahil's T-03 waits on it.
- Decision (2026-10-08, D-37): Sahil's approval of the event names is optional during initial development; he is told in the team chat and may object afterwards.
- Assumption: the planning step settles the conflict between three layouts of an event (architecture 07 section 3.2 item 6, challenge specs section 10, architecture 04 events table) and records the choice in the plan; a choice that changes another stream's contract comes back to Tanmay as a question.
- Sources for the event names: `docs/design/challenge-specs.md` section 10; for the transport: architecture 02, 03, 05, 06 (signing, edge relay, idempotence on `(instance_id, seq)`).
