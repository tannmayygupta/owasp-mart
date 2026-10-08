---
type: epic
title: "Instances start, run, reset and clean up reliably"
parent: initiative-lab
covers: [FR-INS-01, FR-INS-02, FR-INS-03, FR-INS-04, FR-INS-05, FR-INS-06, FR-INS-07, FR-INS-08, FR-INS-09, FR-INS-11]
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Instances start, run, reset and clean up reliably

## Description

The orchestrator creates a private instance on request from a template, waits for health and flag injection, tracks its state, resets it with new flags, tears it down at expiry or inactivity, and a reconciler repairs any difference between recorded and real state.

## Outcome

Users get a ready instance within a bounded time and the host never accumulates leftovers; the signal is the acceptance criteria of the instance lifecycle requirements passing on VM-I and the measured start time and memory per instance.

## Requirements

Numbered source: docs/prd/PRD.md section 5.5 (FR-INS-01 to 09 and FR-INS-11); FR-INS-10 (instance access) belongs to epic-edge-gate-and-event-path. Spikes S-4, S-13.

## Done when

1. A cold instance becomes ready within the target fixed by spike S-4 and is never shown as ready before flag injection finished.
2. Learner instances stop after 60 minutes of inactivity or 4 hours in total; candidate instances follow the assessment window; reset gives new flags.
3. After killing the orchestrator mid-provision, the reconciler removes leftovers within about a minute and the database state matches Docker (spike S-13).
4. Per-user, per-company and global quotas are enforced and the measured memory per instance replaces the old 400 MB estimate (OI-21).
5. Deployed and verified on the VMs through epic-environments-and-deployment.

## Boundaries

The orchestrator, templates, state machine, timing, reset and quotas. Not network isolation details (epic-isolation-and-hardening) and not what runs inside the shop (initiative-target).

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md
- prd, docs/prd/PRD.md, section 5.5
- decision, initial.md D-23, D-24
- architecture, docs/architecture/07-repo-and-workstreams.md, section 3.3 (orchestrator interface)

## Notes

- Handoff: quotas are read through QuotaPort and SettingsPort, faked until initiative-platform epic-admin-and-operations provides them.
- Open question: idle candidate instances (OI-23), start retries (OI-24), clock start (OI-22).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
