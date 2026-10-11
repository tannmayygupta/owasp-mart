---
id: 5
type: story
title: "Stub shop, fake ingest and lab harness"
parent: epic-lab-baseline
covers: [LB-6]
after: [2, 3, 4]
hitl: false
risk: high
---

# Stub shop, fake ingest and lab harness

## Description

Builds a tiny stub shop satisfying the instance contract, and a Compose harness that starts one full instance with pass-through sidecar, edge and gate stubs and an injection step.

## Acceptance Criteria

Verify: One command starts a full stub instance on a laptop that answers health, becomes ready only after the injection marker, serves a planted flag and emits one app event the fake ingest validates; the stub shop passes the instance-contract conformance check.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md
