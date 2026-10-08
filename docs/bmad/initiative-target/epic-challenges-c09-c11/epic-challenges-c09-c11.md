---
type: epic
title: "Challenges C09 to C11: logging, SSRF, exceptional conditions"
parent: initiative-target
covers: [FR-CHL-10, FR-CHL-11, FR-CHL-12]
after: []
assignee: "Sahil Roy"
risk: high
---

# Challenges C09 to C11: logging, SSRF, exceptional conditions

## Description

C09 (legacy login route that is neither logged nor alerted), C10 (SSRF through the seller image import to a fake metadata service) and C11 (the seller KYC check that fails open) are built as designed.

## Outcome

The last three challenges work end to end; the signal is the exploit tests passing on the vulnerable build and failing on the fixed one.

## Requirements

Numbered source: docs/prd/PRD.md section 5.6.3 (FR-CHL-10 to 12) and the cards in docs/design/challenge-specs.md section 2.

## Done when

1. Each challenge's exploit test passes on the vulnerable build and fails on the fixed build.
2. C09's proof of "attack happened, zero events recorded" comes from the shop's own events, never from the platform reading the shop database.
3. C10's fetcher reaches only the internal fake metadata service and cannot reach the host gateway or `host.docker.internal`.
4. C11's sentinel flag shows only when the store was approved by the fail-open path.
5. Verified in the lab harness first, then deployed and verified on the instance VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

These three challenges. Not the sidecar rule that evaluates the C09 window (initiative-lab epic-flags-detection-and-sidecar).

## References

- parent, docs/bmad/initiative-target/initiative-target.md
- prd, docs/prd/PRD.md, section 5.6
- design, docs/design/challenge-specs.md, sections 2, 5 and 10
- decision, initial.md D-20, D-26, D-32

## Notes

- Handoff: this epic supplies the content for C09 to C11; the set-level checks are in epic-catalogue-hints-and-verification.
- Open question: DC-11 (C09 via shop-sent events) needs confirmation by the owner of the shop-to-platform contract, stream L.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
