---
type: epic
title: "End-to-end suite and demo readiness"
parent: initiative-lab
covers: []
after: []
assignee: "Tanmay Gupta"
risk: medium
---

# End-to-end suite and demo readiness

## Description

The cross-stream end-to-end suite runs a learner and a candidate journey through the deployed site, the demo is rehearsed on the laptop and the online system, and the final submission checklist is complete.

## Outcome

The demo and the hiring flow work end to end for the examiners; the signal is the end-to-end suite green on the deployed system and a rehearsal recorded.

## Requirements

- LX-1: An end-to-end suite covers signup, instance start, a captured flag, an assessment attempt, scoring and a recruiter report on the deployed system (docs/architecture/07-repo-and-workstreams.md section 5).
- LX-2: A load check shows the concurrency target of NFR-PRF holds on the deployed VMs.
- LX-3: The demo script is rehearsed on the laptop and on the online system, with the fallback procedure.
- LX-4: The final submission pack (report evidence, repository link, demo script) is checked.

## Done when

1. The end-to-end suite passes on the deployed system and in the laptop fallback.
2. The load check result is recorded with real numbers.
3. A demo rehearsal is done and the problems found are recorded.

## Boundaries

Cross-stream verification only. It adds no features; defects found go back to the owning stream.

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md
- architecture, docs/architecture/07-repo-and-workstreams.md, section 5
- decision, initial.md D-33

## Notes

- Assumption: this epic is proposed by Claude Code to hold the cross-stream suite; the user has not confirmed it. Without it no epic owns the end-to-end suite.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
