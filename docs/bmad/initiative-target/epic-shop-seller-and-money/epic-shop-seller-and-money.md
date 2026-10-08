---
type: epic
title: "Sellers, refunds, disputes and payouts work correctly"
parent: initiative-target
covers: [FR-SHP-06, FR-SHP-10]
after: []
assignee: "Sahil Roy"
risk: medium
---

# Sellers, refunds, disputes and payouts work correctly

## Description

Sellers register a store, list products, fulfil orders and manage staff; refunds, disputes, commissions and payouts follow the correct marketplace model (seller bears refunds, proportional commission reversal, append-only ledger).

## Outcome

The money side of the marketplace behaves correctly so that the deliberate flaws stand out as flaws; the signal is FR-SHP-06 and FR-SHP-10 passing.

## Requirements

Numbered source: docs/prd/PRD.md section 5.19 (FR-SHP-06, FR-SHP-10) and docs/design/challenge-specs.md section 4 (refund model).

## Done when

1. A seller registers a store, waits for approval, creates products and fulfils orders; a pending seller can edit the profile but not publish.
2. A partial refund reverses commission in proportion and payout net matches the formula in FR-SHP-10; refunds carry idempotency keys.
3. The correct model enforces "refunded total not above amount paid" on every path before the C04 quick-refund path is added.
4. Verified in the lab harness first, then deployed and verified on the instance VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

Seller flows and the money model. Not the C04, C10 and C11 weaknesses.

## References

- parent, docs/bmad/initiative-target/initiative-target.md
- prd, docs/prd/PRD.md, section 5.19
- design, docs/design/challenge-specs.md, section 4
- decision, initial.md D-24, D-32

## Notes

- Handoff: epic-shop-core-and-roles provides the users, stores, products and orders this epic extends.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
