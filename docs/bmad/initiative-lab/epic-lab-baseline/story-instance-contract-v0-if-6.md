---
id: 2
type: story
title: "Instance contract v0 (IF-6)"
parent: epic-lab-baseline
covers: [LB-3]
after: [1]
hitl: false
risk: medium
---

# Instance contract v0 (IF-6)

## Description

Writes the contract the shop and every in-instance service obey: containers, env, health, labels, injection protocol and runtime profile.

## Acceptance Criteria

Verify: The contract validates and stream T has approved it as consumer; conformance of the stub shop is checked in the harness entry.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md

## Notes

- Decision (2026-10-08, Tanmay): the error registry (P-02) and the catalogue stubs (T-02) are not merged yet, so this contract uses the error-code family names (INST-*, ORCH-*, EVT-*) and the catalogue field names from the architecture, marked "to confirm"; a small follow-up pull request aligns them after P-02 and T-02 merge.
- Co-owned with stream T (Sahil), who approves it as consumer: request his review on the pull request before merging (CODEOWNERS `/contracts/instance/`). Early pull request, branch `shared-L-02`, because Sahil's T-03 waits on it.
