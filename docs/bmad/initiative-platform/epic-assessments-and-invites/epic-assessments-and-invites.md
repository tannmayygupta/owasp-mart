---
type: epic
title: "Recruiters create assessments and invite candidates"
parent: initiative-platform
covers: [FR-ASM-01, FR-ASM-02, FR-ASM-03, FR-ASM-04, FR-ASM-05, FR-ASM-06]
after: []
assignee: "Akshay Gupta"
risk: medium
---

# Recruiters create assessments and invite candidates

## Description

A recruiter builds an assessment template, invites candidates with single-use hashed links, tracks the invite lifecycle, and hands a consented attempt to the lab through the AttemptPort.

## Outcome

Recruiters can run a fair, repeatable assessment round; the signal is the acceptance criteria of FR-ASM-01 to 06 passing, including the hand-off to the lab.

## Requirements

Numbered source: docs/prd/PRD.md section 5.3 (FR-ASM-01 to FR-ASM-06). Open: write-up required or optional (OI-14), results timing (OI-15).

## Done when

1. A recruiter creates and edits a template and rules already running attempts are not changed.
2. Invites are single-use, hashed, bound to one email and expire; resend, revoke and re-invite work and every state change is logged.
3. Accepting an invite shows the consent screen first, declining ends the invite with a minimal record, and accepting hands a consented attempt to the lab port.
4. A re-invite creates a new attempt and keeps the old one marked superseded.
5. The invite email is verified through the outbox.
6. Deployed and verified on the platform VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

Templates, invites and the hand-off. Not the attempt state machine and clock (initiative-lab epic-attempts-scoring-and-integrity).

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- prd, docs/prd/PRD.md, section 5.3
- decision, initial.md D-22, D-12
- architecture, docs/architecture/07-repo-and-workstreams.md, section 3.5 (ports)

## Notes

- Handoff: AttemptPort is provided by stream L; build against the in-memory fake until the real one lands.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
