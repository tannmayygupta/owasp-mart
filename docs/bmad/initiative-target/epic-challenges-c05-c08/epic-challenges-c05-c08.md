---
type: epic
title: "Challenges C05 to C08: misconfiguration, components, authentication, integrity"
parent: initiative-target
covers: [FR-CHL-06, FR-CHL-07, FR-CHL-08, FR-CHL-09]
after: []
assignee: "Sahil Roy"
risk: high
---

# Challenges C05 to C08: misconfiguration, components, authentication, integrity

## Description

C05 (unauthenticated diagnostics page), C06 (lodash prototype pollution in the isolated import service), C07 (weak password-reset code on the finance account) and C08 (unsigned payment webhook) are built as designed.

## Outcome

Four more challenges work end to end; the signal is the exploit tests passing on the vulnerable build and failing on the fixed one, and the C06 pollution input confirmed on Node 24.

## Requirements

Numbered source: docs/prd/PRD.md section 5.6.3 (FR-CHL-06 to 09) and the cards in docs/design/challenge-specs.md section 2.

## Done when

1. Each challenge's exploit test passes on the vulnerable build and fails on the fixed build.
2. C05's diagnostics page shows only a synthetic object and C06's import service has no network, no database and a fresh process per job.
3. C07's reset mailbox is unreadable by the player and C08's sentinel flag releases only on an unsigned sandbox event.
4. No challenge here gives code execution or file read in the shop container.
5. Verified in the lab harness first, then deployed and verified on the instance VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

These four challenges. Not the catalogue set data and write-ups as a whole.

## References

- parent, docs/bmad/initiative-target/initiative-target.md
- prd, docs/prd/PRD.md, section 5.6
- design, docs/design/challenge-specs.md, sections 2, 8 and 9
- decision, initial.md D-26, D-32

## Notes

- Handoff: this epic supplies the content for C05 to C08; the set-level checks are in epic-catalogue-hints-and-verification.
- Unknown: the C06 pollution input on Node 24 (spike S-9).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
