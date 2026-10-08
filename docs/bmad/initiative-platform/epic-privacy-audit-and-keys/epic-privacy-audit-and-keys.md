---
type: epic
title: "Privacy, consent, audit and deletion work as promised"
parent: initiative-platform
covers: [FR-PRV-01, FR-PRV-02, FR-PRV-03, FR-PRV-04, FR-PRV-05, FR-PRV-06, FR-PRV-07, FR-PRV-08, FR-PRV-09, FR-PRV-10, FR-PRV-11, FR-PRV-12, FR-PRV-13, FR-PRV-14, FR-PRV-15, FR-PRV-16, FR-PRV-17, FR-PRV-18, FR-PRV-19, FR-PRV-20]
after: []
assignee: "Akshay Gupta"
risk: high
---

# Privacy, consent, audit and deletion work as promised

## Description

The platform shows the consent screen and records consent, keeps a tamper-evident audit log, encrypts evidence with one key per attempt and can shred it, deletes data on schedule, handles deletion and withdrawal requests, and states its choices honestly.

## Outcome

Candidates and learners keep control of their data and the team can prove it; the signal is the acceptance criteria of FR-PRV-01 to 20 passing and a backup restore test showing shredded data unreadable.

## Requirements

Numbered source: docs/prd/PRD.md section 5.16 (FR-PRV-01 to FR-PRV-20) and data table in section 9. Per-attempt key per D-35. Open: consent record retention (OI-37), incident procedure (OI-34), legal review (OI-33).

## Done when

1. The consent screen and consent records exist and match the data inventory; withdrawal needs one click and the 7-day undo window works.
2. The audit log verifies end to end including the 12-month purge and concurrent writes (spike S-10), and deleting a candidate removes the identity mapping but not the rows.
3. After a candidate's key is deleted, a restore from a 14-day backup shows that candidate's data unreadable while others remain readable.
4. The retention, learner warning, invite purge and log purge jobs are registered and run on schedule, the invite purge is verified once invites exist (epic-assessments-and-invites), and an admin can see the last run (SM-8).
5. The legal review action is recorded (OI-33) and the notice never claims a legal duty the research does not support (FR-PRV-16).
6. The emails this epic owns (retention warning, deletion request and confirmation, withdrawal) are verified through the outbox.
7. Deployed and verified on the platform VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

Consent, audit, keys, retention, the deletion workflow and the data assembly behind exports. Not the export screens and files (epic-dashboards-and-exports) and not the lab's evidence capture (epic-flags-detection-and-sidecar), which stores through the key service.

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- prd, docs/prd/PRD.md, sections 5.16 and 9
- decision, initial.md D-12, D-25, D-35
- architecture, docs/architecture/04-data-and-state.md
- constraint, docs/research/RS-H-privacy-lifecycle.md

## Notes

- Handoff: provides KeyPort (stream L uses a fake until this epic) and deletes lab-owned data through the AttemptPort purge call.
- Decision: per-attempt data keys (D-35); ASVS level 3 for the key service and audit subsystem.
- Open question: the official DPDP Gazette text was never read; all statements are secondary (OI-33).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
