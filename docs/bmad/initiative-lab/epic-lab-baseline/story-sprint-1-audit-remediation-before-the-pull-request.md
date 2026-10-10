---
id: 13
type: story
title: "Sprint 1 audit remediation before the pull request"
parent: epic-lab-baseline
covers: [LB-1, LB-3, LB-4, LB-5, LB-6, LB-7, LB-9, LE-1, LE-6, LE-8]
after: [12]
hitl: false
risk: medium
---

# Sprint 1 audit remediation before the pull request

## Description

Fixes what the brutal audit of 2026-10-11 found that must not reach the pull request: stale or false statements in traceability, dev-logs, ADR 0022, CHANGELOG and the task list (ticks that outran their Done-when now carry dated notes), control characters and BOM files, handoff register gaps, CI first-run hardening, image and secret hygiene, IAM tag conditions and the other small safety fixes. The audit record is docs/bmad/initiative-lab/audit-2026-10-11-sprint-1.md; the larger findings stay in its backlog.

## Acceptance Criteria

Verify: Every stale statement named by the audit is corrected against real evidence; the tree has no control characters or BOM in tracked text files; all suites and the Linux proof pass on the final tree; the audit record lists what was fixed and what is left.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md
