---
type: epic
title: "Catalogue, hints, write-ups and exploit verification for all 11 challenges"
parent: initiative-target
covers: [FR-CHL-01, FR-CHL-13, FR-CHL-14, FR-CHL-15, FR-CHL-16, FR-CHL-17]
after: []
assignee: "Sahil Roy"
risk: medium
---

# Catalogue, hints, write-ups and exploit verification for all 11 challenges

## Description

The catalogue holds all 11 challenges with tags, tiers, milestones, three-level hints, post-solve write-ups and player briefs, the independence rule is proved across all challenges, and the 11 exploit tests run in CI as release gates.

## Outcome

The catalogue is complete and trustworthy; the signal is FR-CHL-01, 13, 14, 15, 16 and 17 passing and CI blocking a release when any exploit test fails.

## Requirements

Numbered source: docs/prd/PRD.md section 5.6.3 (FR-CHL-01, 13 to 17) and docs/design/challenge-specs.md sections 1, 6, 8 and 9. Open: whether and when candidates see write-ups (OI-14), tag re-verification (OI-35).

## Done when

1. Every challenge page shows both OWASP tags, CWE and ATT&CK ids re-checked on the official sites, a tier and a brief that never contains a flag.
2. Cross-challenge tests prove that solving any one challenge captures no other flag and that no exploit reaches the platform or host.
3. The 11 exploit tests run in CI and a failing test blocks release.
4. Hint texts and write-ups exist for all 11 challenges and the write-up is hidden until the challenge is solved.
5. The decoy flag locations from the challenge specs section 13 are placed and none is credited by the lab.
6. Verified in the lab harness first, then deployed and verified on the instance VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

The set-level content and verification. Not the challenge implementations.

## References

- parent, docs/bmad/initiative-target/initiative-target.md
- prd, docs/prd/PRD.md, section 5.6
- design, docs/design/challenge-specs.md, sections 1, 6, 8, 9
- decision, initial.md D-06, D-07, D-08, D-26, D-32

## Notes

- Handoff: each challenge epic supplies its own content; this epic owns the set-level checks (independence, tags, release gate).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
