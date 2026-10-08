---
id: 1
type: story
title: "Repository skeleton and tooling run end to end (tracer bullet)"
parent: epic-lab-baseline
covers: [LB-1, LB-2]
after: []
hitl: true
risk: high
---

# Repository skeleton and tooling run end to end (tracer bullet)

## Description

Creates the monorepo layout with uv and pnpm workspaces and pinned tools, the CI skeleton, CODEOWNERS and the Compose profiles with `scripts/dev.mjs`, and verifies Docker on Tanmay's PC.

## Acceptance Criteria

Verify: `node scripts/dev.mjs hello` starts a hello container on Tanmay's PC and the CI skeleton runs green on a pull request.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md
- docs/architecture/07-repo-and-workstreams.md#1-monorepo-layout

## Notes

- Decision: story approved by Tanmay on 2026-10-08 as the first task of the project; it is an early pull request (branch `shared-L-01`) because Akshay (P-01) and Sahil (T-01, T-02) wait on it.
- Risk check outside the criteria (high risk): after the merge, Akshay on his Mac and Sahil on his Windows PC each clone `main` and run `node scripts/dev.mjs hello` on their own machine; each reports the result to Tanmay.
- Open question: GitHub handles of Akshay and Sahil for CODEOWNERS; answering it is part of this story.
- Open question: whether Docker runs on Windows 11 Home with WSL2 on this PC (EF-26 conflicting); this story settles it.
