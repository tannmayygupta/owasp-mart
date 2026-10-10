---
id: 12
type: story
title: "Adopt RFC 9457 problem details in IF-5 and IF-2"
parent: epic-lab-baseline
covers: [LB-5, LB-9]
after: [4, 9, 11]
hitl: false
risk: medium
---

# Adopt RFC 9457 problem details in IF-5 and IF-2

## Description

Moves the error body of the orchestrator API (IF-5) and the lab API (IF-2) to RFC 9457 problem details: standard members type, title, status, detail and instance, with code, request_id and field kept as extension members, media type application/problem+json. Updates both OpenAPI files, examples, both mocks, the checkers, the Python client and fake host, the contract texts, ADRs 0018 and 0019, the contract changelog and the handoffs for Akshay (H-81, H-91). Decided by the developer on 2026-10-09 after the ADR 0019 source research.

## Acceptance Criteria

Verify: Both contracts validate with the new Problem schema; every error answer of both mocks and of the Python host is a valid problem details body with the right media type; no old-style body (message member) remains; all suites pass, including on Linux in Docker.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md
