---
type: epic
title: "The shop runs inside an instance: seeding, injection, events, services"
parent: initiative-target
covers: [FR-SHP-11, FR-SHP-12, FR-SHP-13, FR-SHP-14, FR-SHP-15]
after: []
assignee: "Sahil Roy"
risk: high
---

# The shop runs inside an instance: seeding, injection, events, services

## Description

The shop builds a seeded snapshot, receives flags from the injector at start, exposes health and runs under the runtime profile, sends signed app events through the sidecar, and ships the supporting containers: combined mock services, the isolated import service and the bot controller. It also provides the snapshot skeleton and the per-epic seed-data mechanism, so each later epic adds its own seed data without editing shared files.

## Outcome

An instance of the shop starts fast, carries unique flags and talks to the platform only through events; the signal is FR-SHP-11 to 15 passing in the lab harness and the measured shop start time and bot memory (spikes S-4, S-5).

## Requirements

Numbered source: docs/prd/PRD.md section 5.19 (FR-SHP-11 to FR-SHP-15) and the instance contract in docs/architecture/07-repo-and-workstreams.md section 3.2. Related: FR-INS-02 (container content), FR-FLG-03 (injection side).

## Done when

1. The shop starts from a CI-built snapshot, the injector patches flags and writes the marker, and the shop is never ready before that.
2. The shop runs non-root with a read-only filesystem and no egress, and has no route to the platform database, Valkey, the orchestrator or other instances.
3. The mock-services container serves payment, KYC, metadata and the XSS collector, reachable only inside the instance network.
4. The import service runs a fresh process per job with no network and no database access, and the bot opens pages only of its own instance for a fixed time.
5. Verified in the lab harness first, then deployed and verified on the instance VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

How the shop and its services live inside an instance. Not the shop's business features (epic-shop-core-and-roles, epic-shop-seller-and-money) and not the challenges.

## References

- parent, docs/bmad/initiative-target/initiative-target.md
- prd, docs/prd/PRD.md, section 5.19
- architecture, docs/architecture/07-repo-and-workstreams.md, section 3.2
- decision, initial.md D-18, D-24, D-26

## Notes

- Unknown: Chromium memory per instance (S-5), shop cold start (S-4); if the bot is too heavy, one shared bot browser per host replaces it.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
