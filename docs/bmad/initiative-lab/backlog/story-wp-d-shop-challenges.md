---
id: 60
type: story
title: "Work package D: shop and challenges (C09 event, milestones, decoys, shop hardening, T-32 script)"
parent: none
covers: ["C01", "C03", "C05", "C07", "C08", "C09", "C10", "FR-SHP-14", "FR-FLG-07", "T-32"]
after: []
assignee: "tannmayygupta"
refined: false
hitl: true
risk: medium
---

# Work package D: shop and challenges

## Description

The shop posts `shop.security_event_written` so C09 M2 tells the builds apart; loose milestones are tightened and the catalogue text matches the rules; decoys are placed per instance; the milestone-to-event mapping is documented (IF-4 1.0.1, IF-7 1.2.1); the shop deferred-work list is implemented; T-32 has a script with a vulnerable and a fixed leg and a runbook.

## Acceptance Criteria

1. **Both builds are told apart by the rules**
   **Given** the events of the vulnerable and of the fixed build
   **When** the ingest rules read them
   **Then** the vulnerable build earns the milestones and the fixed build does not (`apps/api/tests/test_ingest_shop_rules.py`).
2. **No exploit broke**
   **Given** the hardening
   **When** `node scripts/release-gate.mjs` runs
   **Then** 11 of 11 pass on both builds.
3. **T-32 script ready**
   **Given** `scripts/verify-deployed-exploits.mjs` and its runbook
   **When** the leader runs the runbook commands on vm-i
   **Then** both legs are recorded (not yet run: needs the leader).