---
id: 5
type: bug
title: "The shop's app events do not fit the event contract, so the sidecar drops them and most milestones cannot be credited"
parent: none
covers: ["C01", "C02", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11", "FR-DET-04", "FR-DET-08"]
after: [3]
assignee: ""
refined: true
hitl: false
risk: high
severity: P1
---

# The shop's app events do not fit the event contract

## Description

The developer asked to check that everything the target stream (Sahil) built is wired and answers correctly. The local flag proof (story 3) showed each challenge returns its own flag, but did not look at the events. Checking them against the posted-event schema of IF-4 showed that the shop posts events the sidecar refuses (it validates the same schema), and that two events the milestone rules read are never posted. The first and second milestone of most challenges therefore cannot be credited on the live lab; only the flag capture (the sidecar's own event) works.

## Reproduction

`node scripts/e2e-local-flags.mjs --docker` before the fix: 52 PASS, 16 FAIL. C01 (field names), C02 (members and values), C04 (missing members), C05 (missing `route`), C07 (members, one event per wrong try), C08 (missing `order_id` and `verified`), C09 (`result` words), C10 (missing `job_id`, a class outside the enum), C11 (outcome words, a colon in an id), C06 (no `import.job` posted at all), C10 (nobody posts `meta.request_served`), C02 (the catalogue decoy cards were not planted).

## Cause Hypothesis (confirmed)

The shop's emitters were written to the event names, not to the field lists of the contract, and no test posted them through the schema. The sidecar validates every posted body with `instance-events.posted.schema.json` and answers 422, so the events are lost.

## Acceptance Criteria

1. **Every event the shop and the mock services post fits the contract**
   **Given** the shop in instance mode with the real injector
   **When** every exploit runs
   **Then** no posted event fails the posted-event schema.
2. **Each exploit produces the events its milestone rules read**
   **Given** `apps/api/src/vulnmart/ingest/milestone_rules.json`
   **When** an exploit runs
   **Then** the events of milestone 1 and 2 appear (C03 and the first milestone of C11 are covered elsewhere and say so).
3. **The decoys of C02 exist**
   **Given** an injected instance
   **When** a player forges the code of an unsold staff test card
   **Then** it redeems with a marker, never the flag, and milestone 2 can be reached before the flag card.
4. **Tests**
   **Given** the suites
   **When** they run
   **Then** the shop, exploit, mock-services and ingest tests pass, and the local proof runs with the event checks.

## References

- source — contracts/events/instance-events.posted.schema.json, services/sidecar/src/sidecar.mjs
- source — apps/api/src/vulnmart/ingest/milestone_rules.json
- parent — docs/bmad/initiative-lab/backlog/story-catalogue-fixes-and-local-flag-proof.md

## Notes

- Decision: 2026-10-20, the developer asked Tanmay's session to take over the shop and challenge work, so the shop is changed here without Sahil.
- Decision: the stored value `system:kyc-fallback` stays in the shop's database; the event carries `system_kyc_fallback` because an IF-4 id cannot hold a colon. The milestone rule follows.
