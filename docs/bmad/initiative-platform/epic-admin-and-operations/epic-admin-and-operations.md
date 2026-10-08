---
type: epic
title: "Admins approve, operate and audit safely"
parent: initiative-platform
covers: [FR-ADM-01, FR-ADM-02, FR-ADM-03, FR-ADM-04, FR-ADM-05, FR-ADM-06, FR-ADM-07, FR-ADM-08]
after: []
assignee: "Akshay Gupta"
risk: medium
---

# Admins approve, operate and audit safely

## Description

Admins can approve or reject companies, manage users, force-stop instances, set quotas and retention defaults, see capacity, read the audit log and use logged break-glass access, while being unable to read candidate answers otherwise.

## Outcome

The platform can be run by an admin without ever exposing candidate data by default; the signal is the acceptance criteria of FR-ADM-01 to 08 passing.

## Requirements

Numbered source: docs/prd/PRD.md section 5.17 (FR-ADM-01 to FR-ADM-08). Open: break-glass duration and alert recipients (OI-12).

## Done when

1. An admin approves, rejects and suspends companies with reasons, and every action is audited.
2. Without break-glass an admin sees counts and statuses but no candidate content; with it, access is named, justified, time-boxed, alerted and logged.
3. Admin login requires TOTP and meets the ASVS level 3 review.
4. The capacity view shows running instances, memory, CPU, queue depth and failures from the lab's health endpoints.
5. Deployed and verified on the platform VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

Admin screens and settings. Not instance operations themselves (initiative-lab).

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- prd, docs/prd/PRD.md, section 5.17
- decision, initial.md D-19, D-35

## Notes

- Handoff: consumes InstancePort (force-stop, capacity) and the lab health endpoints from stream L, and provides SettingsPort and QuotaPort that initiative-lab epic-orchestrator-and-instance-lifecycle uses to enforce quotas.
- Open question: break-glass duration and who receives the real-time alert (OI-12).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
