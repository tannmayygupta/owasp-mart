---
type: epic
title: "Target baseline and sprint-zero contracts"
parent: initiative-target
covers: []
after: []
assignee: "Sahil Roy"
risk: medium
---

# Target baseline and sprint-zero contracts

## Description

The shop skeleton runs in a container on Sahil's machine and inside the lab harness, the challenge catalogue schema and 11 stub entries exist, the instance contract and event schema are reviewed as consumer, and an exploit test runner skeleton works against any instance URL.

## Outcome

The lab and the platform can render and score challenges before the real content exists, and the shop developer can run and test the shop inside a real instance from day one; the signal is the shop skeleton passing the instance contract in the lab harness.

## Requirements

- TB-1: The challenge catalogue schema (IF-7) and 11 stub entries exist (docs/architecture/07-repo-and-workstreams.md sections 3.1 and 7.7).
- TB-2: The target stream has reviewed the instance contract v0 (IF-6) and the instance event schema (IF-4) as consumer.
- TB-3: The shop skeleton meets the instance contract inside the lab harness: health, readiness after the injector marker, one app event, a planted flag (docs/architecture/07-repo-and-workstreams.md section 3.2).
- TB-4: An exploit test runner skeleton runs a test against any instance URL (pass on vulnerable, fail on fixed).
- TB-5: The developer environment is verified on Sahil's PC (NFR-POR-03, Q-24).

## Done when

1. The challenge catalogue schema and 11 stub entries are merged and validate in CI.
2. The shop skeleton starts in the lab harness, reports ready only after the injector marker, serves a planted flag and emits one app event the fake ingest accepts.
3. The exploit test runner shows pass on the vulnerable stub and fail on the fixed stub.
4. Sahil's machine runs Docker, Node 24, uv and the skills verifier.

## Boundaries

Stream T's share of sprint zero. Not the harness and the fakes themselves (initiative-lab epic-lab-baseline), which this epic consumes.

## References

- parent, docs/bmad/initiative-target/initiative-target.md
- architecture, docs/architecture/07-repo-and-workstreams.md, sections 3.2, 4 and 7.7
- decision, initial.md D-33, D-35

## Notes

- Assumption: the entries here that wait on initiative-lab epic-lab-baseline cannot be built before those entries merge; each carries that as an unknown.
- Tracer bullet: entry 1, the thinnest path: the shop skeleton runs in a container on Sahil's PC and answers its health endpoint.
- Decision: no closing end-to-end suite for this epic; the exploit test runner skeleton plays that role (2026-10-08).
- Waits on initiative-lab epic-lab-baseline entries 2, 3 and 5 (instance contract, instance events, lab harness); entries 3 and 4 here carry that as unknowns.
- Decision (2026-10-09): entry 2 (story 1.2, T-02) unknown settled. L-01 (repository skeleton) is merged to `main`, so the catalogue folders `contracts/catalog/` and `challenges/catalog/` exist. Unknown removed; story 1.2 is ready. Built on the EARLY PR branch `shared-T-02`.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
