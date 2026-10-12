---
id: 6
type: story
title: "Contract checks live in CI"
parent: epic-lab-baseline
covers: [LB-7]
after: [2, 3, 4]
hitl: false
risk: medium
---

# Contract checks live in CI

## Description

Adds the contract checks to CI (schema validity, breaking-change, bundle current, mock validity, provider conformance, migrations, table ownership, compatibility file) and owns the CI ownership and single-Alembic-head checks the other streams rely on.

## Acceptance Criteria

Verify: A deliberately breaking contract change fails CI and a valid one passes.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md
