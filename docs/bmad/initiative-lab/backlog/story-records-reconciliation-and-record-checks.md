---
id: 12
type: story
title: "The records tell the truth and a check keeps them that way (tracker audit 2026-10-21)"
parent: none
covers: ["L-30", "L-09", "D-102", "D-103"]
after: []
assignee: ""
refined: true
hitl: false
risk: low
---

# The records tell the truth and a check keeps them that way

## Description
The tracker audit of 2026-10-21 (`docs/audit/2026-10-21-tracker-audit.md`) found stale trackers, a traceability table that said "Not started" for features that run live, 88 open handoffs for people who are gone, duplicate decision-record numbers, no invite-to-report end-to-end test, and CI that never ran the Valkey tests or the release gate.

## Acceptance Criteria
1. HANDOFFS.md, the three task files, the story plans and `docs/traceability.md` use one vocabulary and evidence-backed statuses (done only with evidence).
2. Every PRD requirement id has a traceability row; every decision record has an index row; no number is used twice.
3. `scripts/check-records.mjs` (with tests) fails when these drift apart, and runs in CI.
4. One test goes from invite through consent, start, flag, submit and report to the release of results through the real services.
5. CI runs the Valkey tests (a real Valkey service) and the release gate (11 of 11 challenges, both builds).
6. What cannot be done without the leader is listed with the exact reason.

## Notes
- Out of scope here (other work packages): attempt lifecycle and quotas (a), company, privacy and mail (b), deploy hardening (c), shop and challenge fixes (d), learner and candidate web (e).