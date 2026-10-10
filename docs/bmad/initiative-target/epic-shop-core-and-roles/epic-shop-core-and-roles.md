---
type: epic
title: "A believable marketplace with six roles"
parent: initiative-target
covers: [FR-SHP-01, FR-SHP-02, FR-SHP-03, FR-SHP-04, FR-SHP-05, FR-SHP-07, FR-SHP-08, FR-SHP-09]
after: []
assignee: "Sahil Roy"
risk: medium
---

# A believable marketplace with six roles

## Description

The marketplace has its identity and neutral look, about 20 tables, six roles with permissions, the customer, support, finance and admin flows, the seeded accounts the challenges need, and strong password hashing, with the seven state machines.

## Outcome

Players can browse, buy and use every role's screens in a realistic shop; the signal is FR-SHP-01 to 05, 07, 08 and 09 passing in a fresh instance.

## Requirements

Numbered source: docs/prd/PRD.md section 5.19 (FR-SHP-01 to 05, 07 to 09) and the model in docs/research/RS-G-shop-domain.md. Seller flows and money are in epic-shop-seller-and-money.

## Done when

1. A customer can browse, search, fill a cart, check out with the simulated payment, track orders, review and open a ticket.
2. Support, finance and admin screens work with the RS-G permission matrix and seller roles are scoped by store.
3. Seeded accounts for every challenge start work in a fresh instance and no seeded password repeats across challenges.
4. No MD5 or unsalted password hash exists anywhere in the shop.
5. Verified in the lab harness first, then deployed and verified on the instance VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

Shop core and roles. Not the seller and money flows and not the challenge weaknesses, which are added by the challenge epics.

## References

- parent, docs/bmad/initiative-target/initiative-target.md
- prd, docs/prd/PRD.md, section 5.19
- decision, initial.md D-09, D-10, D-11, D-24
- research, docs/research/RS-G-shop-domain.md

## Notes

- Handoff: the correct behavior is built first; weaknesses are added by the challenge epics as separate, isolated paths (challenge specs).
- Incepted 2026-10-09 (approved by Sahil): six stories (3.1–3.6) from the T-stream task file, one per task (T-06, T-07, T-14, T-15, T-16) plus a refactor sweep. Coverage matches the epic FR set; validation clean.
- Open ordering note: the initiative lists this epic `after` epic 2 (instance integration), but only stories 3.3 (customer flows) and 3.5 (seeded accounts) need epic 2 (T-08 seeding). 3.1 and 3.2 depend only on T-01 (done) and start in Sprint 1. Pin the epic-2 dependency onto 3.3 and 3.5 when epic 2 is incepted (`unpinned_after` until then).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
