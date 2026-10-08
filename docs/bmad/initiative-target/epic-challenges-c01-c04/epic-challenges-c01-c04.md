---
type: epic
title: "Challenges C01 to C04: access control, crypto, injection, insecure design"
parent: initiative-target
covers: [FR-CHL-02, FR-CHL-03, FR-CHL-04, FR-CHL-05]
after: []
assignee: "Sahil Roy"
risk: high
---

# Challenges C01 to C04: access control, crypto, injection, insecure design

## Description

C01 (cross-store order read), C02 (gift-card codes from a weak hash), C03 (SQL injection and stored XSS) and C04 (refund total beyond the amount paid) are built as designed, each independently solvable, with its flag, milestones, hints, write-up and exploit test.

## Outcome

Four of the 11 challenges work end to end; the signal is the exploit tests passing on the vulnerable build and failing on the fixed one.

## Requirements

Numbered source: docs/prd/PRD.md section 5.6.3 (FR-CHL-02 to 05) and the cards in docs/design/challenge-specs.md section 2 and sections 3, 4.

## Done when

1. Each challenge's exploit test passes on the vulnerable build and fails on the fixed build.
2. Each flag appears only on the intended path and solving one challenge never captures another's flag.
3. Milestones M1 to M3 fire from the events in the specification and the three hint levels never reveal a flag.
4. C03 part B contains the bot to the allow-listed pages so the XSS cannot read other challenges' flags.
5. Verified in the lab harness first, then deployed and verified on the instance VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

These four challenges. Not the catalogue data and write-ups as a set (epic-catalogue-hints-and-verification).

## References

- parent, docs/bmad/initiative-target/initiative-target.md
- prd, docs/prd/PRD.md, section 5.6
- design, docs/design/challenge-specs.md, sections 2 to 4, 8 and 9
- decision, initial.md D-26, D-32

## Notes

- Handoff: this epic supplies the content for C01 to C04 (flags, hints, write-ups, decoy locations); the set-level checks are in epic-catalogue-hints-and-verification.
- Unknown: SQLite ATTACH and load_extension behavior for C03 (spike); correctness of the C06-style isolation does not apply here.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
