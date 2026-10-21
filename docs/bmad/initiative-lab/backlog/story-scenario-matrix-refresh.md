---
id: 22
type: story
title: "Refresh the scenario matrix after packages A to E and build what no package owned"
parent: none
covers: ["C-30", "R-25", "A-27", "R-20", "R-26", "L-30", "D-102"]
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# Refresh the scenario matrix after packages A to E and build what no package owned

## Description
After the merge of packages A to E every scenario marked missing or partial is tested again on main; the seven scenarios without an owner go to package H and are built where the backend allows it.

## Acceptance Criteria
1. Every scenario the first matrix marked MISSING-OWNED-BY A, B, C or E is VERIFIED with a test id, or stays PARTIAL or MISSING with the exact reason.
2. C-30, R-25, A-27, R-20 and R-26 are built or verified with regression tests; C-37 and R-30 carry the exact blocker.
3. `test_scenario_matrix.py` stays green; contract rules and `api:check` pass.