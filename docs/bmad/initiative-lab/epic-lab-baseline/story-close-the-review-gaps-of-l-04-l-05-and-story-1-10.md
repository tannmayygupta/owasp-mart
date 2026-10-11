---
id: 11
type: story
title: "Close the review gaps of L-04, L-05 and story 1.10"
parent: epic-lab-baseline
covers: [LB-5, LB-9]
after: [4, 9, 10]
hitl: false
risk: medium
---

# Close the review gaps of L-04, L-05 and story 1.10

## Description

Fixes by cause the gaps left open by the reviews: reads the sources behind ADR 0019 and corrects the ADR and the IF-2 text where they disagree; runs the Node end-to-end tests in CI (without their duplicate nested Python run) after proving them on Linux with Docker here; adds the P-04 handoff pointer; fixes the recorded mock and test weaknesses (duplicate timeline rows, held-flag clearing, hint order, strict cursor and query parameters, listen errors, exact counts, order-independent tests, the 413 test accepting a reset, expired and wrong-usage certificate cases, the missing-openssl CI branch).

## Acceptance Criteria

Verify: ADR 0019 cites sources that were read and its decisions match them; the end-to-end tests pass on Linux in Docker and run in a CI job; every deferred item of stories 1.9 and 1.10 is fixed with a test that fails before the fix, or re-recorded with a reason; all suites pass.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md
